import json
import types
import unittest
from unittest.mock import AsyncMock, patch

from test_alexa import Limiter, Request, Response
from hashlib import sha256
import sys
import polly


class PollyTests(unittest.IsolatedAsyncioTestCase):
    def test_sigv4_aws_sdk_fixture(self):
        # Independently computed with AWS botocore SigV4Auth for this fixed request.
        # Algorithm: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
        headers = polly.signed_headers('{}', 'AKIDEXAMPLE', 'test-secret', 'us-west-2', '20261022T120000Z')
        self.assertEqual(headers['Authorization'],
                         'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261022/us-west-2/polly/aws4_request, '
                         'SignedHeaders=content-type;host;x-amz-date, '
                         'Signature=40bc047efb9b46bcecdf5316a4a640ed7d4e336fa0287f8884c1391b4d53dd02')
        temporary = polly.signed_headers('{}', 'AKIDEXAMPLE', 'test-secret', 'us-west-2', '20261022T120000Z', 'session')
        self.assertEqual(temporary['x-amz-security-token'], 'session')
        self.assertIn('x-amz-security-token', temporary['Authorization'])

    async def test_synthesis_and_engine_retry(self):
        config = {'AWS_ACCESS_KEY_ID': 'example', 'AWS_SECRET_ACCESS_KEY': 'example-secret'}.get
        success = types.SimpleNamespace(status=200, bytes=AsyncMock(return_value=b'mp3'))
        failure = types.SimpleNamespace(status=400, json=AsyncMock(return_value={'__type': 'EngineNotSupportedException'}))
        fetch = AsyncMock(side_effect=[failure, success])
        self.assertEqual(await polly.synthesize('<b>Hello</b> https://example.com', config, fetch), b'mp3')
        self.assertEqual(fetch.await_count, 2)
        for call, engine in zip(fetch.call_args_list, ['generative', 'neural']):
            self.assertEqual(call.args[0], 'https://polly.us-west-2.amazonaws.com/v1/speech')
            body = json.loads(call.kwargs['body'])
            self.assertEqual(body, dict(Text='Hello [link removed]', TextType='text', OutputFormat='mp3', Engine=engine, VoiceId='Ruth'))
            self.assertEqual(call.kwargs['headers']['host'], 'polly.us-west-2.amazonaws.com')
            self.assertRegex(call.kwargs['headers']['x-amz-date'], r'^\d{8}T\d{6}Z$')
            self.assertRegex(call.kwargs['headers']['Authorization'], r'Signature=[a-f0-9]{64}$')
        fetch = AsyncMock(return_value=types.SimpleNamespace(status=403, json=AsyncMock(return_value={'__type': 'AccessDeniedException'})))
        with self.assertRaises(polly.VoiceUnavailable):
            await polly.synthesize('Hello', config, fetch)
        self.assertEqual(fetch.await_count, 1)
        with self.assertRaises(ValueError):
            await polly.synthesize('x'*301, config, fetch)
        self.assertEqual(fetch.await_count, 1)
        fetch = AsyncMock(side_effect=RuntimeError('secret upstream detail'))
        with self.assertRaisesRegex(polly.VoiceUnavailable, '^voice unavailable$'):
            await polly.synthesize('Hello', config, fetch)

    async def test_endpoint_auth_limits_validation_and_binary(self):
        with patch.dict(sys.modules, {'workers': types.SimpleNamespace(Response=Response, WorkerEntrypoint=object)}):
            import entry
        worker = entry.Default()
        worker.env = types.SimpleNamespace(MCP_JUDGE_TOKEN_HASHES=sha256(b'demo').hexdigest(), IP_LIMITER=Limiter(), SUBJECT_LIMITER=Limiter())
        request = Request({'text': 'hello'})
        request.url = 'https://example.com/tts'
        request.headers = {'Content-Type': 'application/json'}
        self.assertEqual((await worker.fetch(request)).status, 401)
        request.headers = {**Request.headers, 'Origin': 'https://example.com'}
        self.assertEqual((await worker.fetch(request)).status, 503)
        with patch('polly.synthesize', new_callable=AsyncMock, return_value=b'mp3') as synth:
            response = await worker.fetch(request)
            self.assertEqual((response.status, response.body), (200, b'mp3'))
            self.assertEqual(response.headers['Content-Type'], 'audio/mpeg')
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'https://example.com')
            for invalid in ({'text': 'x'*301}, {'text': ''}, {'text': '<b></b>'}, {'text': 3}, [], {'text': 'ok', 'extra': 1}):
                request.message = invalid
                self.assertEqual((await worker.fetch(request)).status, 400)
            request.message = {'text': 'x'*65536}
            self.assertEqual((await worker.fetch(request)).status, 413)
            self.assertEqual(synth.await_count, 1)
            request.message = {'text': '<b>' + 'x'*300 + '</b>'}
            self.assertEqual((await worker.fetch(request)).status, 200)
            self.assertEqual(synth.call_args.args[0], 'x'*300)
        request.method = 'OPTIONS'
        self.assertEqual((await worker.fetch(request)).status, 204)
        request.method = 'POST'
        for limiter in ('IP_LIMITER', 'SUBJECT_LIMITER'):
            setattr(worker.env, limiter, types.SimpleNamespace(limit=AsyncMock(return_value={'success': False})))
            self.assertEqual((await worker.fetch(request)).status, 429)
            setattr(worker.env, limiter, Limiter())
        request.headers = {**Request.headers, 'Origin': 'https://evil.example'}
        self.assertEqual((await worker.fetch(request)).status, 403)
