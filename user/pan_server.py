#!/usr/bin/env python3
"""Lightweight Flask API that extracts PAN card details from uploads."""

from __future__ import annotations

import io
import logging
import os
import re
from datetime import datetime
from typing import Dict, Iterable, Optional

from flask import Flask, jsonify, request

try:  # Optional OCR dependencies – the server gracefully degrades without them.
    from PIL import Image  # type: ignore
except Exception:  # pragma: no cover - dependency is optional
    Image = None  # type: ignore

try:
    import pytesseract  # type: ignore
except Exception:  # pragma: no cover - dependency is optional
    pytesseract = None  # type: ignore


logging.basicConfig(level=logging.INFO)
LOGGER = logging.getLogger(__name__)

app = Flask(__name__)

PAN_REGEX = re.compile(r"\b([A-Z]{5}[0-9]{4}[A-Z])\b")
DOB_REGEX = re.compile(r"\b(\d{1,2}[\-/]\d{1,2}[\-/]\d{2,4})\b")
INVALID_NAME_CHARS = re.compile(r"[^A-Z0-9\s./-]")


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS, GET"
    return response


@app.route("/api/health", methods=["GET"])
def health_check():
    """Simple readiness endpoint."""
    return jsonify({"status": "ok"})


@app.route("/api/pan/extract", methods=["POST", "OPTIONS"])
def extract_pan_details():
    """Accept a PAN card image and return extracted metadata."""
    if request.method == "OPTIONS":
        return ("", 204)

    file = request.files.get("pan_front")
    if file is None or file.filename == "":
        return _error_response("PAN front image is required.")

    data = file.read()
    if not data:
        return _error_response("Uploaded file is empty.")

    text = _extract_text(data)
    if not text.strip():
        LOGGER.info("No text detected in uploaded PAN image.")

    details = _parse_pan_text(text)

    response = {
        "status": "ok",
        "panNumber": details.get("pan_number", ""),
        "name": details.get("name", ""),
        "fatherName": details.get("father_name", ""),
        "dob": details.get("dob", ""),
        "rawText": text.strip(),
    }
    return jsonify(response)


def _extract_text(data: bytes) -> str:
    """Attempt OCR extraction, falling back to UTF-8 decoding if unavailable."""
    ocr_text: Optional[str] = None
    if Image is not None and pytesseract is not None:
        try:
            with Image.open(io.BytesIO(data)) as image:
                ocr_text = pytesseract.image_to_string(image)
        except Exception as exc:  # pragma: no cover - dependent on external binary
            LOGGER.warning("OCR extraction failed: %s", exc)
    if ocr_text and ocr_text.strip():
        return ocr_text

    try:
        return data.decode("utf-8", errors="ignore")
    except Exception:
        return ""


def _parse_pan_text(text: str) -> Dict[str, str]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    joined = " ".join(lines)

    pan_number = _normalise_pan_number(_find_pan(joined, lines))
    name = _normalise_name(_find_by_keywords(lines, ["NAME"]))
    father_name = _normalise_name(
        _find_by_keywords(lines, ["FATHER'S NAME", "FATHERS NAME", "FATHER NAME", "FATHER"])
    )
    dob = _normalise_dob(_find_by_keywords(lines, ["DOB", "DATE OF BIRTH", "BIRTH"]))

    if not dob:
        dob = _normalise_dob(_find_first_match(DOB_REGEX, joined))

    return {
        "pan_number": pan_number,
        "name": name,
        "father_name": father_name,
        "dob": dob,
    }


def _find_pan(joined: str, lines: Iterable[str]) -> str:
    match = PAN_REGEX.search(joined)
    if match:
        return match.group(1)

    for line in lines:
        cleaned = _normalise_pan_number(line)
        if _is_valid_pan(cleaned):
            return cleaned
    return ""


def _find_by_keywords(lines: Iterable[str], keywords: Iterable[str]) -> str:
    upper_keywords = [keyword.upper() for keyword in keywords]
    lines_list = list(lines)
    for index, line in enumerate(lines_list):
        upper = line.upper()
        for keyword in upper_keywords:
            if keyword in upper:
                after = line[upper.find(keyword) + len(keyword) :].strip(" :-")
                if not after and ":" in line:
                    after = line.split(":", 1)[1].strip()
                if after:
                    return after
                if index + 1 < len(lines_list):
                    return lines_list[index + 1]
    return ""


def _find_first_match(pattern: re.Pattern[str], text: str) -> str:
    match = pattern.search(text)
    return match.group(1) if match else ""


def _normalise_pan_number(value: str) -> str:
    if not value:
        return ""
    cleaned = re.sub(r"[^A-Z0-9]", "", value.upper())
    cleaned = cleaned[:10]
    return cleaned if _is_valid_pan(cleaned) else ""


def _is_valid_pan(value: str) -> bool:
    return bool(PAN_REGEX.fullmatch(value))


def _normalise_name(value: str) -> str:
    if not value:
        return ""
    cleaned = INVALID_NAME_CHARS.sub(" ", value.upper()).strip()
    if not cleaned:
        return ""
    parts = [part for part in cleaned.split() if part]
    return " ".join(part.capitalize() for part in parts)


def _normalise_dob(value: str) -> str:
    if not value:
        return ""
    candidate = value.strip()
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%y", "%d-%m-%y"):
        try:
            parsed = datetime.strptime(candidate, fmt)
            return parsed.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return candidate


def _error_response(message: str, status_code: int = 400):
    response = jsonify({"status": "error", "message": message})
    response.status_code = status_code
    return response


if __name__ == "__main__":
    port = int(os.environ.get("PAN_SERVER_PORT") or os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "").lower() in {"1", "true", "yes"}
    LOGGER.info("Starting PAN extraction server on port %s", port)
    app.run(host="0.0.0.0", port=port, debug=debug)
