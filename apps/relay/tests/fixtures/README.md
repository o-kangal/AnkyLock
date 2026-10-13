# Test-only RSA keys

Generated for relay auth tests; they sign fake Google ID tokens and protect nothing.
`jwks.json` holds the public half of `test_rsa_private.pem` (kid `test-key-1`).
`other_rsa_private.pem` is deliberately absent from the JWKS to test bad signatures.
