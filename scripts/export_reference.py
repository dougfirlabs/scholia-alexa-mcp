"""Export immutable reference data from the legacy implementation."""
import json
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'legacy/python'))
import mcp_protocol as p
values = {name: getattr(p, name) for name in ['ATOM_CATALOG', 'PRIMITIVES', 'OPERATORS', 'EXAMPLES', 'RESOURCE_TEXT', 'RESOURCE_DEFS']}
values.update(KNOWN_TAGS=sorted(p.KNOWN_TAGS), TOOLS=p.tool_definitions(), INITIALIZE=p.initialize({}), CATALOG=p.catalog_tool()['structuredContent'])
(root / 'src/reference.json').write_text(json.dumps(values, indent=2) + '\n')
# JavaScript lowercasing is not Unicode casefolding (e.g. ligatures, Cherokee).
# Store only code points whose casefold differs from lowercase.
fold = {chr(i): chr(i).casefold() for i in range(0x110000) if chr(i).casefold() != chr(i).lower()}
(root / 'src/casefold.json').write_text(json.dumps(fold, sort_keys=True) + '\n')
