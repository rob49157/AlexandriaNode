-- Data fix, no schema change (KEY-BINDING.md, R8).
--
-- litDataToEncryptHash held sha256 of the PLAINTEXT key envelope
-- {"v":1,"k":"<book key>","arweaveHash":"…"}: a fingerprint of every book's AES
-- key, served by GET /api/rental/decrypt-params. It now holds sha256 of the
-- SEALED envelope (litEncryptedKeyId), which is public ciphertext and exactly the
-- sealed-key hash a reader signs in the unlock message. controller/litProtocol.js
-- computes the same thing for new uploads: sha256 over the UTF-8 bytes, lower-case hex.
UPDATE "Upload"
SET "litDataToEncryptHash" = encode(sha256(convert_to("litEncryptedKeyId", 'UTF8')), 'hex')
WHERE "litEncryptedKeyId" IS NOT NULL;
