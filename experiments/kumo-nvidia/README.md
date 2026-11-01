# MacRadar × NVIDIA Kumo Tabular — isolated trial

This proof of concept lives on its own Git branch. It is NOT enabled in MacRadar, does not alter the database, and does not deploy anything.

## Purpose

Verify that the NVIDIA-hosted Kumo Tabular API accepts a football-like tabular classification request with labeled context rows and a new row to predict.

**The context is deliberately synthetic**: any predicted probabilities are not evidence of football accuracy. Historical MacRadar data must be prepared and tested chronologically before adding real match forecasts.

## Before starting

- A free NVIDIA Developer account with access to the Kumo Tabular API Catalog endpoint
  https://build.nvidia.com/nvidia/kumo-tabular
- NVIDIA API key created in your own account. Never commit it or send it in chat/screenshots.
- Node.js 22+ (already used by this repository).

## Safe offline preview

```bash
node experiments/kumo-nvidia/smoke-test.js
```

No external request is sent.

## Test hosted NVIDIA endpoint

Set the key only for the current terminal session, then run the test:

```bash
read -rs -p 'NVIDIA API key: ' NVIDIA_API_KEY; echo
export NVIDIA_API_KEY
node experiments/kumo-nvidia/smoke-test.js --send
unset NVIDIA_API_KEY
```

Do not use `set -x` or include the key in commands pasted to chats. The CLI sends **synthetic, non-private** examples only. It prints an HTTP error if a trial key, API quota, schema, or endpoint fails. API requests can count toward free trial limits.

## Next phase (NOT done yet)

1. Validate MacRadar PostgreSQL's historical match results and bookmaker snapshot coverage without writing to DB.
2. Build features only from information available before each match kickoff, and group snapshots without copying outcomes into predictive features.
3. Split test data chronologically; measure multiclass log loss, calibration, Brier score, and baseline against bookmaker market probabilities and current MacRadar system.
4. If tested and promising, integrate behind an opt-in feature flag in the backend, then expose results in the APK.
5. Provide fallback when NVIDIA trial access is rate-limited or unavailable.

## Terms and security

NVIDIA's **hosted free endpoint is for development/testing/evaluation, not unlimited production use**. Free access and rate limits may change. Do not send secrets, private user data, or confidential information to hosted API. The API key must stay server-side, never embedded in the APK or GitHub repository.

References:
- https://docs.api.nvidia.com/nim/reference/nvidia-kumo-tabular-statuspolling
- https://build.nvidia.com/nvidia/kumo-tabular
- https://docs.api.nvidia.com/nim/docs/product
