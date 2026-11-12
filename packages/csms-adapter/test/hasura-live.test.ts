import { describe, expect, it } from 'vitest';

const live = process.env.HASURA_LIVE_TEST === '1';
const hasuraUrl = process.env.HASURA_URL ?? 'http://localhost:8090/v1/graphql';
const tokenUrl =
  process.env.CITRINEOS_TOKEN_URL ??
  'http://localhost:8180/realms/evstation/protocol/openid-connect/token';

async function serviceToken(): Promise<string> {
  const secret = process.env.KC_CSMS_PROVISIONER_CLIENT_SECRET;
  if (!secret)
    throw new Error('KC_CSMS_PROVISIONER_CLIENT_SECRET is required for live Hasura test');
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'csms-provisioner',
      client_secret: secret,
    }),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('service token missing');
  return body.access_token;
}

async function gql(token: string, query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(hasuraUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe.skipIf(!live)('live Hasura adapter role', () => {
  it('forces the managed marker on a station insert', async () => {
    const token = await serviceToken();
    const now = new Date().toISOString();
    const result = await gql(
      token,
      `mutation($t: timestamptz!, $name: String!) {
        insert_ChargingStations_one(object: {
          ocppConnectionName: $name, locationId: 1, tenantId: 1,
          protocol: "ocpp1.6", createdAt: $t, updatedAt: $t
        }) { id capabilities }
      }`,
      { t: now, name: `LIVE-MARKER-${Date.now()}` },
    );
    const data = result.body.data as {
      insert_ChargingStations_one?: { id?: number; capabilities?: unknown };
    };
    expect(data.insert_ChargingStations_one?.capabilities).toEqual({ evstation_managed: true });
    const id = data.insert_ChargingStations_one?.id;
    if (id) {
      const remove = await gql(
        token,
        `mutation($id: Int!) {
          update_ChargingStations_by_pk(pk_columns: {id: $id}, _set: {capabilities: {}}) { id }
        }`,
        { id },
      );
      expect(JSON.stringify(remove.body)).toMatch(/capabilities|not found|permission/i);
    }
  });

  it('cannot update an unowned cp001 station and cannot attach an EVSE to it', async () => {
    const token = await serviceToken();
    const lookup = await gql(
      token,
      `query { ChargingStations(where: {ocppConnectionName: {_eq: "cp001"}}) { id } }`,
    );
    const id = (lookup.body.data as { ChargingStations?: Array<{ id: number }> })
      .ChargingStations?.[0]?.id;
    expect(id).toBeTruthy();
    const result = await gql(
      token,
      `mutation($id: Int!) {
        update_ChargingStations_by_pk(pk_columns: {id: $id}, _set: {firmwareVersion: "should-not-write"}) { id firmwareVersion }
      }`,
      { id },
    );
    expect(result.body.data).toEqual({ update_ChargingStations_by_pk: null });
    const now = new Date().toISOString();
    const evse = await gql(
      token,
      `mutation($id: Int!, $t: timestamptz!) {
        insert_Evses_one(object: {stationId: $id, tenantId: 1, evseId: "9", createdAt: $t, updatedAt: $t}) { id }
      }`,
      { id, t: now },
    );
    expect(JSON.stringify(evse.body)).toMatch(/permission|check constraint|not allowed/i);
  });

  it('the CitrineOS unique ocppConnectionName constraint blocks duplicate provisioning', async () => {
    const token = await serviceToken();
    const now = new Date().toISOString();
    const result = await gql(
      token,
      `mutation($t: timestamptz!) {
        insert_ChargingStations_one(object: {
          ocppConnectionName: "cp001", locationId: 1, tenantId: 1,
          protocol: "ocpp1.6", createdAt: $t, updatedAt: $t
        }) { id }
      }`,
      { t: now },
    );
    expect(JSON.stringify(result.body)).toMatch(/unique|duplicate|constraint/i);
  });
});
