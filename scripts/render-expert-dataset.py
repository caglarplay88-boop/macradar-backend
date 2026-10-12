"""Render expert message files without launching training."""
import argparse
import hashlib
import json
import sys
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "modal_runtime"))
from expert_training_messages import render_expert_example

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False,
                      sort_keys=True, separators=(",", ":")).encode("utf-8")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    args = parser.parse_args()
    dataset = args.dataset.resolve()
    manifest_raw = (dataset / "manifest.json").read_bytes()
    source = json.loads(manifest_raw)
    assert source["exportVersion"] == "macradar-expert-dataset-export-v1"
    model = json.loads((ROOT / "modal_runtime/model_manifest.json").read_text())
    assert source["modelId"] == model["modelId"]
    assert source["modelRevision"] == model["revision"]
    assert source["promptContractHash"] == sha(
        (ROOT / "modal_runtime/analysis_contract.py").read_bytes()
    ), "Prompt contract mismatch"
    expected_files = {
        "train.examples.jsonl", "validation.examples.jsonl",
        "test.examples.jsonl", "quarantine.jsonl"
    }
    assert set(source["files"]) == expected_files
    for name in sorted(expected_files):
        raw = (dataset / name).read_bytes()
        expected = source["files"][name]
        assert sha(raw) == expected["sha256"], "Source file hash mismatch"
        assert len(raw) == expected["bytes"], "Source file size mismatch"
        assert len(raw.decode("utf-8").splitlines()) == expected["examples"]

    files = {}
    metadata = {}
    languages = Counter()
    scopes = Counter()
    identities = set()
    for partition in ("train", "validation", "test"):
        records = []
        for line in (dataset / (partition + ".examples.jsonl")).read_text().splitlines():
            rendered = render_expert_example(line)
            assert rendered["language"] == "tr", "Only Turkish messages may be exported"
            assert rendered["exampleId"] not in identities, "Duplicate example"
            identities.add(rendered["exampleId"])
            records.append(rendered)
            languages[rendered["language"]] += 1
            scopes[rendered["fixtureScope"]] += 1
        assert len(records) == source["counts"][partition]["examples"]
        name = partition + ".messages.jsonl"
        raw = b"".join(encode(record) + b"\n" for record in records)
        files[name] = raw
        metadata[name] = {
            "sha256": sha(raw), "bytes": len(raw), "examples": len(records)
        }
    rendered_manifest = {
        "renderVersion": "macradar-expert-training-messages-v1",
        "sourceDatasetId": source["datasetId"],
        "sourceManifestHash": sha(manifest_raw),
        "modelId": source["modelId"],
        "modelRevision": source["modelRevision"],
        "promptContractHash": source["promptContractHash"],
        "rendererHash": sha((ROOT / "modal_runtime/expert_training_messages.py").read_bytes()),
        "counts": source["counts"],
        "languages": dict(languages),
        "scopes": dict(scopes),
        "files": metadata,
        "trainingGate": source["trainingGate"],
        "tokenBudgetVerified": False,
        "semanticAcceptanceVerified": False,
        "trainingStarted": False
    }
    render_id = sha(encode(rendered_manifest))
    rendered_manifest = {"renderId": render_id, **rendered_manifest}
    files["manifest.json"] = encode(rendered_manifest) + b"\n"

    parent = ROOT / "artifacts/expert_training_messages"
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    ignore = parent / ".gitignore"
    if not ignore.exists():
        with ignore.open("x") as handle:
            handle.write("*/\n")
    destination = parent / render_id
    for name, raw in files.items():
        existing = destination / name
        if existing.exists() and existing.read_bytes() != raw:
            raise ValueError("Existing message export content conflict")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, raw in files.items():
        target = destination / name
        if not target.exists():
            with target.open("xb") as handle:
                handle.write(raw)
            target.chmod(0o600)

    print("EGITIM MESAJI ORNEK SAYISI:", len(identities))
    print("DIL SAYILARI:", json.dumps(dict(languages), ensure_ascii=False))
    print("VERI KAPSAMI:", json.dumps(dict(scopes), ensure_ascii=False))
    print("MESAJ EXPORT KIMLIGI:", render_id)
    print("MESAJ EXPORT DIZINI:", destination.relative_to(ROOT))
    print("SIRADAKI KONTROL: SABIT QWEN TOKENIZER ILE TOKEN BUTCESI")
    print("TOKEN VE ANLAM KABULU BEKLIYOR; EGITIM BASLATILMADI")

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("MESAJ EXPORT BASARISIZ:", type(error).__name__, file=sys.stderr)
        sys.exit(1)
