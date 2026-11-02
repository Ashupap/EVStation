"""
Minimal OCPP 1.6J charger simulator for testing a CSMS (e.g. CitrineOS).

Requires: pip install "websockets>=14"

Usage examples:
  python charger_simulator.py --url ws://localhost:8081 --id CP001
  python charger_simulator.py --url ws://localhost:8082 --id CP001 --password secret123
  python charger_simulator.py --url ws://localhost:8081 --id CP001 --no-session

The charger dials OUT to <url>/<id>, exactly as a real charger does.
"""
import argparse
import asyncio
import base64
import json
import uuid
from datetime import datetime, timezone

from websockets.asyncio.client import connect

CALL, CALLRESULT, CALLERROR = 2, 3, 4


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class Charger:
    def __init__(self, ws, args):
        self.ws = ws
        self.args = args
        self.pending = {}
        self.transaction_id = None
        self.energy_wh = 0

    async def call(self, action, payload):
        """Send a CALL and wait for the CSMS reply."""
        msg_id = str(uuid.uuid4())
        fut = asyncio.get_running_loop().create_future()
        self.pending[msg_id] = fut
        frame = [CALL, msg_id, action, payload]
        print(f"--> {json.dumps(frame)}")
        await self.ws.send(json.dumps(frame))
        return await asyncio.wait_for(fut, timeout=30)

    async def listen(self):
        """Handle replies to our calls and commands sent by the CSMS."""
        async for raw in self.ws:
            print(f"<-- {raw}")
            msg = json.loads(raw)
            if msg[0] == CALLRESULT and msg[1] in self.pending:
                self.pending.pop(msg[1]).set_result(msg[2])
            elif msg[0] == CALLERROR and msg[1] in self.pending:
                self.pending.pop(msg[1]).set_exception(RuntimeError(msg))
            elif msg[0] == CALL:
                await self.handle_command(msg[1], msg[2], msg[3])

    async def handle_command(self, msg_id, action, payload):
        """Reply to remote commands from the CSMS (always accept in this demo)."""
        if action in ("RemoteStartTransaction", "RemoteStopTransaction", "Reset"):
            result = {"status": "Accepted"}
        elif action == "GetConfiguration":
            result = {"configurationKey": [], "unknownKey": payload.get("key", [])}
        elif action == "ChangeConfiguration":
            result = {"status": "Accepted"}
        else:
            await self.ws.send(json.dumps(
                [CALLERROR, msg_id, "NotImplemented", f"{action} not supported", {}]))
            return
        await self.ws.send(json.dumps([CALLRESULT, msg_id, result]))
        print(f"--> handled {action}")

    async def heartbeat_loop(self, interval):
        while True:
            await asyncio.sleep(interval)
            await self.call("Heartbeat", {})

    async def run(self):
        listener = asyncio.create_task(self.listen())

        # 1. Announce ourselves
        boot = await self.call("BootNotification", {
            "chargePointVendor": "DemoVendor",
            "chargePointModel": "SIM-60",
            "chargePointSerialNumber": self.args.id,
            "firmwareVersion": "1.0.0",
        })
        if boot.get("status") != "Accepted":
            print(f"CSMS did not accept boot: {boot}. Register the station first.")
            return
        interval = max(int(boot.get("interval", 30)), 5)
        asyncio.create_task(self.heartbeat_loop(interval))

        # 2. Report connector status
        await self.call("StatusNotification", {
            "connectorId": 1, "errorCode": "NoError",
            "status": "Available", "timestamp": now()})

        if not self.args.no_session:
            await self.charging_session()

        print("\nSimulator idle. Heartbeats continue; try remote commands from the CSMS.")
        await listener

    async def charging_session(self):
        # 3. Driver taps RFID
        auth = await self.call("Authorize", {"idTag": self.args.id_tag})
        if auth["idTagInfo"]["status"] != "Accepted":
            print(f"idTag rejected: {auth}. Add it to the CSMS authorization list.")
            return

        # 4. Start transaction
        await self.call("StatusNotification", {
            "connectorId": 1, "errorCode": "NoError",
            "status": "Preparing", "timestamp": now()})
        start = await self.call("StartTransaction", {
            "connectorId": 1, "idTag": self.args.id_tag,
            "meterStart": 0, "timestamp": now()})
        self.transaction_id = start["transactionId"]
        await self.call("StatusNotification", {
            "connectorId": 1, "errorCode": "NoError",
            "status": "Charging", "timestamp": now()})

        # 5. Meter values while charging (simulate ~30 kW)
        for _ in range(3):
            await asyncio.sleep(5)
            self.energy_wh += 250
            await self.call("MeterValues", {
                "connectorId": 1, "transactionId": self.transaction_id,
                "meterValue": [{"timestamp": now(), "sampledValue": [
                    {"value": str(self.energy_wh),
                     "measurand": "Energy.Active.Import.Register", "unit": "Wh"},
                    {"value": "30000", "measurand": "Power.Active.Import", "unit": "W"},
                ]}]})

        # 6. Stop
        await self.call("StopTransaction", {
            "transactionId": self.transaction_id, "idTag": self.args.id_tag,
            "meterStop": self.energy_wh, "timestamp": now(), "reason": "Local"})
        await self.call("StatusNotification", {
            "connectorId": 1, "errorCode": "NoError",
            "status": "Available", "timestamp": now()})


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="ws://localhost:8081", help="CSMS WebSocket base URL")
    p.add_argument("--id", default="CP001", help="Charge point ID (path suffix)")
    p.add_argument("--password", help="Basic-auth password (security profile 1/2)")
    p.add_argument("--id-tag", default="DEMO_TAG", help="RFID tag used for the test session")
    p.add_argument("--no-session", action="store_true", help="Only boot + heartbeat")
    args = p.parse_args()

    headers = {}
    if args.password:
        token = base64.b64encode(f"{args.id}:{args.password}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"

    uri = f"{args.url.rstrip('/')}/{args.id}"
    print(f"Connecting to {uri} ...")
    async with connect(uri, subprotocols=["ocpp1.6"], additional_headers=headers) as ws:
        print("WebSocket connected.\n")
        await Charger(ws, args).run()


if __name__ == "__main__":
    asyncio.run(main())
