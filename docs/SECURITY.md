# Security and Credential Handling

## Files

| File | Handling |
| --- | --- |
| `backend/.env` | Local plaintext runtime configuration. Never commit or share. |
| `backend/.env.enc` | Encrypted backup artifact. Safe to store privately when the password is managed separately. |
| `backend/.env.example` | Blank configuration template. Safe to commit. |
| `backend/.env.decrypted` | Temporary plaintext output. Delete after use. |
| `Other Logs/` | Local runtime data and browser artefacts. Ignored from Git. |

## Encryption format

The encrypted credential bundle uses:

- Fernet authenticated encryption.
- PBKDF2-HMAC-SHA256 key derivation.
- A random salt stored with the ciphertext.
- 390,000 key-derivation iterations.

The encryption password is not stored in the repository or inside the encrypted payload.

## Password rotation

1. Ensure the current local plaintext `.env` or `.env.decrypted` is available.
2. Encrypt it with a new password and a new random salt.
3. Verify decryption with the new password.
4. Replace `backend/.env.enc`.
5. Commit only the encrypted file.
6. Delete temporary plaintext output when finished.

## Incident response

If credentials are exposed:

1. Revoke or rotate the affected provider credentials immediately.
2. Inspect Git history, GitHub repository visibility, logs, and chat transcripts.
3. Replace the local `.env` values.
4. Re-encrypt the updated configuration.
5. Review provider audit logs for unexpected access.

## Publishing checklist

- `git status` reviewed.
- `backend/.env` is ignored.
- No private key, token, password, or service-account JSON appears in staged files.
- Runtime logs, browser profiles, generated data, and caches are excluded.
- Repository visibility is confirmed as private.
- GitHub token used for publishing is revoked or rotated after the task.
