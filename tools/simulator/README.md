# tools/simulator

Minimal OCPP 1.6J charging-station simulator for manual testing and CI
against the local dev stack (default fixtures **cp001** / **DEADBEEF** —
test-only, see docs/DECISIONS.md; both overridable via flags).

It dials OUT to `ws://localhost:8081/<id>` (CitrineOS dev WebSocket,
security profile 0 — dev/test-only binding, see docs/RUNBOOK.md
"OCPP WebSocket exposure").

## Setup (one-off)

```shell
python3 -m venv .venv
.venv/bin/pip install -r tools/simulator/requirements.txt   # pinned exact
```

## The full session (what CI asserts)

BootNotification → heartbeats → StatusNotification(Available) →
Authorize → Preparing → StartTransaction (assert `transactionId > 0`) →
Charging → 3 × MeterValues → StopTransaction (`reason: Local`,
`meterStop`) → StatusNotification(Available).

Assertions (hard failures, **exit 2**):
`BootNotification.status == Accepted`, `Authorize.idTagInfo.status ==
Accepted`, `StartTransaction.transactionId` a positive int, every Call
must be answered by a CallResult (CALLERROR frames fail the run; OCPP
1.6J `StopTransactionResponse` has no status field, so a CallResult
arriving at all is the assertion there).

## Run

```shell
# Prereqs: pnpm dev:stack healthy (pnpm health), and the fixtures created
# once by the smoke test's upserter (see the Location → ChargingStation
# cp001 → EVSE → Connector → Authorization DEADBEEF/Accepted chain):
pnpm smoke    # creates/updates the fixtures idempotently, runs this
              # simulator, and verifies this run's transaction in ocpp-db
.venv/bin/python tools/simulator/charger_simulator.py --exit-after-session
```

The smoke test auto-detects a repo-root `.venv` python first, then any
python with the pinned `websockets` importable; or set `SIM_PYTHON`. Fixture
defaults can be overridden with `SMOKE_STATION_ID` / `SMOKE_ID_TAG` /
`SMOKE_LOCATION_NAME` (they are passed to the simulator as `--id` /
`--id-tag`).

Useful flags (see also `--help`):

```shell
--id cp001                  # station id (URL path suffix)          [cp001]
--id-tag DEADBEEF           # RFID tag                              [DEADBEEF]
--url ws://localhost:8081   # CSMS base URL                         [dev default]
--password secret123        # Basic auth (profile 1 servers: port 8082)
--no-session                # boot + heartbeats only, stay idle
--exit-after-session        # exit 0 after one session (CI mode)
```

Behavior differences from a naive demo charger (deliberate):

- failures _raise_ (assertions above) — no print-and-return, so scripts
  and CI get honest exit codes;
- CSMS CALLERROR frames on our pending calls abort the session (exit 2)
  instead of surfacing as a raised `RuntimeError` somewhere unrelated.
