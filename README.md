##Main-Project
This is a small local Express + SQLite API prototype for demonstrating authentication, file sharing, and server-side authorization.

## Requirements
- Node.js LTS (18 or newer recommended)
- npm

## Run on Windows
Open PowerShell in this folder:

```powershell
npm install
npm start
```

The API listens at `http://localhost:3000`.

## Demo accounts
- Professor: `prof` / `prof`
- Student 1: `stu1` / `demo1`
- Student 2: `stu2` / `demo2`
- Student 3: `stu3` / `demo3`
- Student 4: `stu4` / `demo4`
- Student 5: `stu5` / `demo5`

These are demo-only credentials. Do not deploy this prototype publicly.

## Endpoints
- `GET /api/health` — server health check
- `POST /api/login` — JSON `{ "username": "...", "password": "..." }`
- `POST /api/logout` — destroy current session
- `GET /api/me` — current user
- `GET /api/courses` — list configured courses and current enrollment status
- `POST /api/courses/:code/enroll` — student JSON `{ "rollNumber": "24B1234" }`; enrolls automatically on a roster match
- `POST /api/courses/:code/roster` — course professor JSON `{ "rollNumbers": ["24B1234", "24B2345"] }`; adds roster entries
- `GET /api/courses/:code/roster` — course professor views the roster
- `DELETE /api/courses/:code/roster/:rollNumber` — course professor removes an unused roster entry; entries already used by enrolled accounts cannot be removed
- `GET /api/courses/:code/assignments` — list assignments and submission status; professors see submitted files
- `GET /api/courses/:code/solutions` — list solutions visible to the current user
- `GET /api/courses/:code/solution-recipients?assignmentId=:id` — professor gets enrolled students' and professor's public keys for a solution linked to that assignment
- `GET /api/courses/:code/notes` — list notes this course member can access
- `GET /api/courses/:code/note-recipients` — list the professor and enrolled users with or without registered public keys
- `GET /api/courses/:code/feedback` — list encrypted grade/comment records for the professor or the current student
- `GET /api/courses/:code/feedback-recipients?assignmentId=:id` — professor gets public keys for students who submitted that assignment
- `POST /api/courses/:code/assignments/:assignmentId/feedback` — professor saves encrypted grade/comments for one submitter
- `GET /api/courses/:code/materials` — list official materials available to the current user
- `GET /api/courses/:code/material-recipients` — professor gets course public keys for material upload or replacement
- `POST /api/courses/:code/assignments` — course professor JSON `{ "title": "Assignment 1", "deadlineAt": "2030-10-31T18:30:00.000Z" }`
- `DELETE /api/courses/:code/assignments/:assignmentId/submission` — student withdraws their submission before the deadline
- `GET /api/files` — list files visible to current user
- `POST /api/files` — multipart form: `file` and `category`
- `GET /api/files/:id/download` — download after server-side authorization
- `POST /api/files/:id/release` — professor releases/hides a solution; JSON `{ "released": true }`

Categories:
- `assignment`: student uploads; only owner and professor can read
- `notes`: students and professor can upload; enrolled users with a wrapped key can decrypt each encrypted note
- `solution`: professor uploads an encrypted solution for a specific assignment; professor can read immediately, and enrolled students with upload-time key envelopes can read after release
- `feedback`: professor records a structured grade and comments for a particular assignment submission; only that student and professor can decrypt
- `material`: professor uploads or replaces encrypted official files; enrolled users with upload-time key envelopes can decrypt

## Course roster enrollment

The prototype has one course, `CS416M`. Log in as `prof` and use the roster table under My Courses to add eligible roll numbers one at a time, see which entries are available or already used, and remove unused entries. A roll number already linked to an enrolled account cannot be removed. A student logs in, enters a roll number in the enrollment panel, and is enrolled automatically if the number matches an available roster entry. A roll number can be used by only one account in the course. Students see their enrolled courses first and open a course card to view submissions. They must be enrolled before the server will list, accept, or download course files; professors retain course access.

This prototype does not verify that the person entering a roll number owns it. Roster matching checks course eligibility, while IITB identity or email OTP would provide stronger identity verification and is out of scope. Treat this as a demonstration flow, not strong identity proof.

For an API-only setup, log in as the professor and send `POST /api/courses/CS416M/roster` with a JSON `rollNumbers` array. Then log in as a student and send `POST /api/courses/CS416M/enroll` with a `rollNumber`.

The course workspace groups each assignment into its own tab. The selected tab contains its deadline, submission activity, solution and release controls, and grade/feedback. Professors create assignments from the course page with a title and deadline. Each student has at most one active submission per assignment. Students may submit after the deadline; the app marks it late and reports the elapsed time. They can replace or withdraw an existing submission before the deadline; after it, that submission is locked. Withdrawing deletes that submission and its encrypted file from storage. Existing assignment files created before deadlines were added are not linked to a new assignment and remain legacy records.

## Quick manual test with curl.exe
Login and save the session cookie:
```powershell
curl.exe -i -c cookies.txt -H "Content-Type: application/json" -d "{\"username\":\"stu1\",\"password\":\"demo1\"}" http://localhost:3000/api/login
```

To submit an assignment, first enroll in CS416M and make sure the student and professor have registered public keys. Use the browser page to select an assignment and submit; it encrypts the file and includes the assignment ID and wrapped AES keys.

List visible files:
```powershell
curl.exe -i -b cookies.txt http://localhost:3000/api/files
```

For download, use the ID returned by upload:
```powershell
curl.exe -i -b cookies.txt -OJ http://localhost:3000/api/files/FILE_ID/download
```

Repeat login with stu2 and attempt to download stu1's assignment. Expected result: `403 Forbidden`.

## Browser public keys

Open `http://localhost:3000/` and log in. On first login, users without a registered public key are taken to Security key setup. Once registered, key status is available in the separate Security key section. The page generates an RSA-3072 RSA-OAEP/SHA-256 key pair, saves the non-exportable private `CryptoKey` in this browser's IndexedDB, and registers the public JWK once. A key already registered on the server cannot be replaced.

If an administrator clears a user's server-side public-key registration after key loss, a stale local key may still remain in that browser. The Security key section then offers **Discard stale local key** before generating a fresh pair. This does not recover files encrypted to the previous key.

- `GET /api/keys/me` reports current user's registration status.
- `PUT /api/keys/me` registers a public JWK for the current user; repeat registration returns `409`.
- `GET /api/keys/:username` returns that user's registered public JWK to authenticated users.
- `GET /api/assignment-recipients` returns the current user's and professor(s)' public keys for assignment encryption.
- Run `npm test` for key registration and authentication integration tests.

## Encrypted files for all five categories

Use the browser page to submit assignment files. The browser encrypts each file with a fresh random AES-256-GCM key and nonce, then wraps that AES key separately for the submitting student and each professor using RSA-OAEP/SHA-256. The server enforces the exact recipient set, stores only ciphertext and wrapped keys, and returns a user's own wrapped key only after the existing assignment access check. Decryption happens in the browser using the recipient's IndexedDB private key.

Every required recipient must have a registered public key before assignment, solution, or feedback is saved. Notes and materials can be uploaded for the professor and enrolled users with registered keys; the UI lists users without keys and asks for confirmation before excluding them. Existing files created before their category became encrypted remain plaintext and are labeled as legacy. The filename and other file metadata remain visible to the server.

For solutions, the professor uploads from the selected assignment tab. New solution records are linked to that assignment. The browser encrypts the file and wraps its AES key for the professor and every student enrolled at upload time. Upload is blocked if any of those recipients has not registered a public key. The solution starts hidden; the professor can release or hide it from the same tab. On release, students can access only if they were included in the upload-time recipient set and have a wrapped-key copy. Students enrolling later are not silently added and cannot decrypt that existing solution. The server checks release status, course enrollment, and the presence of the student's key envelope before listing or returning a solution. Older solutions without an assignment link remain in a separate section; legacy solution files remain unencrypted and cannot be released through the secure solution controls.

For shared notes, either a student or the professor can upload from the course workspace. The browser encrypts each file with its own AES key and wraps that key for the professor and enrolled students who have registered public keys at upload time. Before uploading, the UI lists members without keys and asks the uploader to confirm; those members are excluded and cannot decrypt the note. The server returns a user's wrapped key only when that user is an enrolled course member with an envelope. Students who enroll later are not automatically added to earlier notes. Existing plaintext notes are labeled as legacy.

For grades and individual feedback, the professor selects an assignment and a student who has submitted it, then enters a grade and comments. The browser encrypts that structured data with a fresh AES-GCM key and wraps the key only for the student and professor. SQLite stores ciphertext and the two key envelopes linked to the exact current submission; the server returns only the current user's envelope. The browser decrypts and displays the record locally. This is not a file upload and does not create a file in `storage/`. Re-entering feedback replaces the existing record with newly encrypted data. Replacing or withdrawing the submission clears its feedback so it cannot be mistaken for feedback on a different file version.

For lecture materials and announcements, only the professor can upload or replace a file. Each upload or replacement uses new ciphertext, a fresh AES key, and envelopes for the professor and currently enrolled students with registered keys. Users without keys are identified before upload and explicitly excluded; students who enroll later do not automatically receive access to existing materials. Replacing a material updates the existing entry with the newly encrypted file and current recipient envelopes.

Direct `POST /api/files` encrypted file uploads must be multipart and include `file` (AES-GCM ciphertext), the category, `courseCode`, `nonce` (base64 12-byte nonce), and `wrappedKeys` (JSON array of `{ "username", "wrappedKey" }`, with RSA-3072 ciphertext encoded in base64). Assignment submissions and solutions also require `assignmentId`; material replacement can include `replaceFileId`. Grades and feedback are not accepted by this file endpoint. Prefer the browser UI, which performs the required crypto steps.

## Known limitations (be honest in the report)
- This is a local prototype, not a production deployment.
- The built-in session store is not suitable for production.
- HTTPS is not configured for localhost; secure cookies and TLS must be configured for deployment.
- Demo accounts are seeded with fixed credentials.
- Private keys are stored in that browser's IndexedDB. Clearing site data, losing the device, or browser storage eviction can make private keys unavailable; no recovery, rotation, synchronization, or backup flow exists.
- The server validates key profile and size but does not verify key ownership with a proof-of-possession challenge.
- Existing legacy files in any category may be plaintext. New uploads through the five category flows are encrypted in the browser; filenames and other file metadata remain visible to the server.
- Existing assignment records from before encryption remain plaintext. Filenames, uploader, category, size, and timestamps are visible to the server.
- No IITB identity integration or email OTP is included. Enrollment is based on a submitted roll number matching a professor-managed roster, so account-to-person identity is not proven. Roster changes are not audited and the current UI only adds entries.
- Only the prototype course `CS416M` is configured; course creation and file category expansion to multiple courses are not implemented.
- No malware scanning or file versioning is included.
- The sample extension allow-list is a usability filter, not a complete file-security solution.
- No protection against a malicious authorized user copying or redistributing downloaded files.
