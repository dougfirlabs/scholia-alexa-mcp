"""Independently verify the shared TypeScript-produced record with legacy Python."""
import json
from pathlib import Path
from store import check_chain, canonical

def test_typescript_chain_fixture():
    raw = (Path(__file__).parent / 'fixtures/typescript-chain.json').read_text().strip()
    payload = json.loads(raw)
    check_chain(payload['chain'], payload['trace']['household_id'], payload['anchor'])
    assert payload['trace'] in payload['chain']
    assert canonical(payload) == raw
