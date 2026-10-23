"""Independently verify the shared TypeScript-produced record with legacy Python."""
import pytest
import json
from pathlib import Path
from store import check_chain, canonical

@pytest.mark.parametrize("fixture", ["typescript-chain", "non-exact-float-chain"])
def test_typescript_chain_fixture(fixture):
    raw = (Path(__file__).parent / f'fixtures/{fixture}.json').read_text().strip()
    payload = json.loads(raw)
    check_chain(payload['chain'], payload['trace']['household_id'], payload['anchor'])
    assert payload['trace'] in payload['chain']
    assert canonical(payload) == raw
