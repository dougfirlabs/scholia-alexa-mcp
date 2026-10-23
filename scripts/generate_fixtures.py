"""Generate Python-owned compatibility evidence; never use production data."""
import asyncio
import json
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'legacy/python'))
import store
import mcp_protocol as p
import tools_alexa
FIELDS = dict(household_id='demo', session_id='fixture', action='dim lights ☃ 😀', reason='Movie time. User asked!', inputs={'float': 1.0, 'small': 1e-7, 'large': 1e20, 'int': 9007199254740993, 'negative_zero': -0.0, 'nested': {'\U00010000': 'astral', '\ue000': 'bmp'}}, approver='Demo user')
async def main():
    memory = store.MemoryStore()
    for i in range(30):
        await store.append(memory, {**FIELDS, 'reason': f'Reason {i}'}, now=1792700000.0 + i * .125)
    path = root / 'tests/fixtures'
    path.mkdir(exist_ok=True)
    (path / 'python-chain.json').write_text(memory.rows['demo'] + '\n')
    (path / 'fields.json').write_text(store.canonical(FIELDS) + '\n')
    messages = [
        {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}
        for method, params in [('initialize', {}), ('ping', {}), ('tools/list', {}), ('resources/list', {}), ('resources/read', {'uri': 'scholialang://overview'}), ('resources/templates/list', {}), ('prompts/list', {})]
    ]
    for name, args in [('scholialang.catalog', {}), ('scholialang.lookup', {'term': 'evidence'}), ('scholialang.get_example', {}), ('scholialang.get_example', {'id': 'hypothesis-evidence-finding', 'format': 'json'}), ('scholialang.lint_snippet', {'snippet': '<Step><Finding>'}), ('scholialang.lookup', {'term': ''}), ('scholialang.get_example', {'format': []})]:
        messages.append({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}})
    messages += [[], {'jsonrpc': '2.0', 'id': None, 'method': 'ping'}, {'jsonrpc': '2.0', 'method': 'notifications/initialized'}, {'jsonrpc': '2.0', 'id': 2, 'method': 'ping', 'params': None}]
    (path / 'protocol.json').write_text(json.dumps([{'message': m, 'expected': p.handle_rpc_message(m)} for m in messages], indent=2) + '\n')
    strings = ['&lt;speak&gt;Hi&#0; https://evil.example&lt;/speak&gt;', 'Hello\u200b\x00\nworld www.evil.example', '&copy; &#x1f600; &NotEqualTilde;', '<b>hi</b> <audio src="https://evil.example"/>']
    (path / 'sanitizer.json').write_text(json.dumps([{'input': s, 'expected': tools_alexa.sanitize(s)} for s in strings], indent=2) + '\n')
asyncio.run(main())
