#!/usr/bin/env python3
"""Validate the real existing APK export HTTP protocol, never invent a card."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import time
import urllib.request
import zipfile


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--android", required=True, type=Path)
    p.add_argument("--event", required=True)
    p.add_argument("--base", default="http://127.0.0.1:3100")
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--state-directory", type=Path)
    args = p.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", args.event):
        raise RuntimeError("INVALID_EVENT_ID")
    source = (args.android / "lib/main.dart").read_text()
    found = re.search(r"const\s+String\s+mobileKey\s*=\s*['\"]([^'\"]+)['\"]", source)
    if not found:
        raise RuntimeError("EXISTING_APK_AUTH_CONFIGURATION_NOT_FOUND")
    headers = {"x-api-key": found.group(1)}
    args.output.mkdir(parents=True, exist_ok=True)

    def get(route):
        request = urllib.request.Request(args.base.rstrip("/") + route, headers=headers)
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read(), dict(response.headers.items())

    def get_json(route):
        return json.loads(get(route)[0])

    before_ids = set()
    if args.state_directory:
        saved = args.state_directory / (args.event + ".json")
        if saved.exists():
            old = json.loads(saved.read_text())
            raw = old.get("odds_raw", {})
            before_ids = set(raw if isinstance(raw, dict) else (r["record_id"] for r in raw))
            del old, raw

    prefix = "/api/matches/" + args.event + "/export"
    initial = get_json(prefix + "?prepare=1")
    duplicate = get_json(prefix + "?prepare=1")
    if initial.get("job_id") != duplicate.get("job_id"):
        raise RuntimeError("DUPLICATE_ACTIVE_EXPORT_JOB")
    job_id = initial["job_id"]
    deadline = time.monotonic() + 30 * 60
    state = initial
    latencies = []
    while state.get("status") in {"QUEUED", "RUNNING"}:
        if time.monotonic() >= deadline:
            raise RuntimeError("REAL_HTTP_EXPORT_TIMEOUT")
        start = time.monotonic()
        health = get_json("/health")
        latencies.append(time.monotonic() - start)
        if not health.get("ok"):
            raise RuntimeError("BACKEND_HEALTH_FAILED_DURING_EXPORT")
        time.sleep(2)
        state = get_json(prefix + "?job=" + job_id + "&status=1")
    if state.get("status") != "READY":
        raise RuntimeError("REAL_EXPORT_JOB_FAILED: " + str(state.get("error") or state.get("status")))
    raw_zip, response_headers = get(prefix + "?job=" + job_id)
    response_headers = {k.lower(): v for k, v in response_headers.items()}
    digest = hashlib.sha256(raw_zip).hexdigest()
    assert digest == state["sha256"] == response_headers["x-export-sha256"]
    assert len(raw_zip) == state["bytes"]
    (args.output / "actual-http-package.zip").write_bytes(raw_zip)
    with zipfile.ZipFile(io.BytesIO(raw_zip)) as archive:
        assert archive.testzip() is None
        data = json.loads(archive.read("match-data.json"))
        manifest = json.loads(archive.read("manifest.json"))
        for item in manifest["files"]:
            content = archive.read(item["name"])
            assert len(content) == item["bytes"]
            assert hashlib.sha256(content).hexdigest() == item["sha256"]
        performance = json.loads(archive.read("performance.json"))
        assert performance["performanceRaw"] == data["performanceRaw"]
        assert performance["performance"] == data["performance"]
    from jsonschema import Draft202012Validator
    root = Path(__file__).resolve().parent.parent
    schema = json.loads((root / "docs/odds-contract/match-data.schema.json").read_text())
    Draft202012Validator(schema).validate(data)
    assert data["match"]["event_id"] == args.event
    records = data["odds_raw"]
    ids = {r["record_id"] for r in records}
    assert len(ids) == len(records)
    assert before_ids <= ids, "PREVIOUS_RAW_RECORDS_LOST"
    assert all(r["raw_evidence_ref"] in data["raw_evidence"] for r in records)
    counts = {m: sum(r["market"] == m for r in records) for m in ["1X2", "OU", "ASIAN", "KG"]}
    assert all(counts.values()), "REAL_FOUR_MARKET_RECORDS_MISSING"
    collection = data["collection"]
    last_success = collection.get("last_successful_scan") or {}
    assert response_headers.get("x-odds-last-success-at", "") == (last_success.get("finished_at") or "")
    expected_refresh = str(collection["export_refresh"]["success"]).lower()
    assert response_headers["x-odds-refresh-success"] == expected_refresh
    report = {
        "event_id": args.event, "job_id": job_id,
        "actual_existing_apk_http_protocol": True,
        "repeated_prepare_same_active_job": True,
        "schema": "PASSED", "zip_and_manifest_hashes": "PASSED",
        "embedded_evidence_links": "PASSED", "previous_raw_ids_preserved": len(before_ids),
        "performance_sections_preserved": True, "raw_market_counts": counts,
        "bytes": len(raw_zip), "sha256": digest,
        "maximum_health_latency_seconds": max(latencies, default=0),
        "collection_status_headers": "PASSED",
        "source_history_records": sum(r["record_origin"] == "source_history" for r in records),
        "export_refresh": collection["export_refresh"],
        "phone_download_and_install": "NOT_PERFORMED",
        "external_macradar_reader_test": "NOT_PERFORMED"
    }
    (args.output / "validation.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == "__main__":
    main()
