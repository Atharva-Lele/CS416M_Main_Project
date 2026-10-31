# IITB Secure Course File Sharing

A local prototype for sharing course files with access controls and browser-side encryption.

## Features

- Login, course enrollment, and assignment deadlines
- Five workflows: submissions, solutions, shared notes, grades and feedback, and lecture materials
- AES-256-GCM file encryption in the browser; RSA-OAEP key wrapping for authorized recipients
- Private keys kept in browser IndexedDB; encrypted file bytes and metadata stored by the server

## Run locally

Requirements: Node.js 18 or newer and npm.

```powershell
npm install
npm start
```

Open <http://localhost:3000>. Use the demo accounts configured in `src/app.js` for testing.

## Notes

This is a demonstration prototype, not a production service. Demo login credentials are fixed. Private keys have no recovery or backup, and legacy files may be plaintext. Do not use real or sensitive data.
