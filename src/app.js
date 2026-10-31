const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const STORAGE_DIR = path.join(ROOT, "storage");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });

const db = new Database(process.env.PROJECTSHARE_DB_PATH || path.join(DATA_DIR, "projectshare.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('student', 'professor'))
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL CHECK(category IN ('assignment','notes','solution','feedback','material')),
    owner_id INTEGER NOT NULL REFERENCES users(id),
    recipient_id INTEGER REFERENCES users(id),
    uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS user_public_keys (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    public_key_jwk TEXT NOT NULL,
    registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS courses (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    professor_id INTEGER NOT NULL REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS course_roster (
    course_code TEXT NOT NULL REFERENCES courses(code) ON DELETE CASCADE,
    roll_number TEXT NOT NULL,
    PRIMARY KEY (course_code, roll_number)
  );
  CREATE TABLE IF NOT EXISTS course_enrollments (
    course_code TEXT NOT NULL REFERENCES courses(code) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    roll_number TEXT NOT NULL,
    enrolled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (course_code, user_id),
    UNIQUE (course_code, roll_number),
    FOREIGN KEY (course_code, roll_number) REFERENCES course_roster(course_code, roll_number)
  );
`);
// Add encrypted assignment metadata without disturbing existing plaintext records.
const fileColumns = new Set(db.prepare("PRAGMA table_info(files)").all().map(column => column.name));
if (!fileColumns.has("encrypted")) db.exec("ALTER TABLE files ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0");
if (!fileColumns.has("encryption_nonce")) db.exec("ALTER TABLE files ADD COLUMN encryption_nonce TEXT");
if (!fileColumns.has("course_code")) db.exec("ALTER TABLE files ADD COLUMN course_code TEXT NOT NULL DEFAULT 'CS416M'");
db.exec(`CREATE TABLE IF NOT EXISTS file_key_envelopes (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  wrapped_key TEXT NOT NULL,
  PRIMARY KEY (file_id, user_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS course_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_code TEXT NOT NULL REFERENCES courses(code) ON DELETE CASCADE,
  title TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS assignment_submissions (
  assignment_id INTEGER NOT NULL REFERENCES course_assignments(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id),
  file_id TEXT NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  late_by_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (assignment_id, student_id)
);`);
const assignmentFileColumns = new Set(db.prepare("PRAGMA table_info(files)").all().map(column => column.name));
if (!assignmentFileColumns.has("assignment_id")) db.exec("ALTER TABLE files ADD COLUMN assignment_id INTEGER REFERENCES course_assignments(id) ON DELETE SET NULL");
const submissionColumns = new Set(db.prepare("PRAGMA table_info(assignment_submissions)").all().map(column => column.name));
if (!submissionColumns.has("late_by_ms")) db.exec("ALTER TABLE assignment_submissions ADD COLUMN late_by_ms INTEGER NOT NULL DEFAULT 0");
db.exec(`CREATE TABLE IF NOT EXISTS assignment_feedback (
  id TEXT PRIMARY KEY,
  course_code TEXT NOT NULL REFERENCES courses(code) ON DELETE CASCADE,
  assignment_id INTEGER NOT NULL REFERENCES course_assignments(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submission_file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  professor_id INTEGER NOT NULL REFERENCES users(id),
  ciphertext TEXT NOT NULL,
  encryption_nonce TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (assignment_id, student_id)
);
CREATE TABLE IF NOT EXISTS feedback_key_envelopes (
  feedback_id TEXT NOT NULL REFERENCES assignment_feedback(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  wrapped_key TEXT NOT NULL,
  PRIMARY KEY (feedback_id, user_id)
);`);
const feedbackColumns = new Set(db.prepare("PRAGMA table_info(assignment_feedback)").all().map(column => column.name));
if (!feedbackColumns.has("submission_file_id")) db.exec("ALTER TABLE assignment_feedback ADD COLUMN submission_file_id TEXT REFERENCES files(id) ON DELETE CASCADE");

function seedDemoUser(oldUsername, username, password, role) {
  const hash = bcrypt.hashSync(password, 10);
  const migrate = db.transaction(() => {
    const oldUser = oldUsername && db.prepare("SELECT id FROM users WHERE username = ?").get(oldUsername);
    const newUser = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (oldUser && !newUser) {
      // Preserve the user's ID so existing file ownership and registered keys stay linked.
      db.prepare("UPDATE users SET username = ?, password_hash = ?, role = ? WHERE id = ?")
        .run(username, hash, role, oldUser.id);
    } else if (!newUser) {
      db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)")
        .run(username, hash, role);
    }
  });
  migrate();
}
seedDemoUser("professor", "prof", "prof", "professor");
seedDemoUser("student1", "stu1", "demo1", "student");
seedDemoUser("student2", "stu2", "demo2", "student");
seedDemoUser(null, "stu3", "demo3", "student");
seedDemoUser(null, "stu4", "demo4", "student");
seedDemoUser(null, "stu5", "demo5", "student");

const professor = db.prepare("SELECT id FROM users WHERE username = 'prof' AND role = 'professor'").get();
db.prepare("INSERT OR IGNORE INTO courses (code, name, professor_id) VALUES ('CS416M', 'CS416M ProjectShare', ?)")
  .run(professor.id);

app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  name: "projectshare.sid",
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // Local HTTP development only. Set true behind HTTPS in deployment.
    maxAge: 2 * 60 * 60 * 1000
  }
}));

// Log completed requests without recording request bodies or credentials.
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, STORAGE_DIR),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID())
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB prototype limit
  fileFilter: (_req, file, cb) => {
    // Basic demo allow-list. Extend deliberately if the project needs more formats.
    const allowed = new Set([".pdf", ".txt", ".png", ".jpg", ".jpeg", ".docx", ".pptx", ".zip"]);
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.has(ext)) return cb(new Error("File type not allowed for this prototype."));
    cb(null, true);
  }
});

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Please log in first." });
  next();
}
function requireProfessor(req, res, next) {
  if (!req.session.user || req.session.user.role !== "professor") {
    return res.status(403).json({ error: "Professor access required." });
  }
  next();
}
function getCourse(code) {
  return db.prepare("SELECT * FROM courses WHERE code = ?").get(code);
}
function isEnrolled(userId, courseCode) {
  return Boolean(db.prepare("SELECT 1 FROM course_enrollments WHERE user_id = ? AND course_code = ?")
    .get(userId, courseCode));
}
function requireCourseEnrollment(req, res, next) {
  if (req.session.user.role === "professor") return next();
  const courseCode = req.params.code || "CS416M";
  if (!isEnrolled(req.session.user.id, courseCode)) {
    return res.status(403).json({ error: "Enroll in this course before accessing course files." });
  }
  next();
}
function publicFileRecord(row) {
  return {
    id: row.id,
    name: row.original_name,
    category: row.category,
    owner: row.owner_username,
    uploadedAt: row.uploaded_at,
    released: Boolean(row.released),
    encrypted: Boolean(row.encrypted)
  };
}
function getFile(id) {
  return db.prepare(`
    SELECT f.*, u.username AS owner_username
    FROM files f JOIN users u ON u.id = f.owner_id
    WHERE f.id = ?
  `).get(id);
}
function canReadFile(user, file) {
  if (!user || !file) return false;
  if (file.category === "notes") {
    const course = getCourse(file.course_code);
    const courseMember = user.role === "professor"
      ? Boolean(course && course.professor_id === user.id)
      : isEnrolled(user.id, file.course_code);
    if (!courseMember) return false;
    if (!file.encrypted) return true; // Existing plaintext notes remain available as legacy files.
    return Boolean(db.prepare("SELECT 1 FROM file_key_envelopes WHERE file_id = ? AND user_id = ?")
      .get(file.id, user.id));
  }
  if (file.category === "feedback") {
    const course = getCourse(file.course_code);
    const isDesignatedStudent = user.role === "student" && file.recipient_id === user.id && isEnrolled(user.id, file.course_code);
    const isCourseProfessor = user.role === "professor" && course && course.professor_id === user.id;
    if (!isDesignatedStudent && !isCourseProfessor) return false;
    if (!file.encrypted) return true;
    return Boolean(db.prepare("SELECT 1 FROM file_key_envelopes WHERE file_id = ? AND user_id = ?")
      .get(file.id, user.id));
  }
  if (file.category === "material") {
    const course = getCourse(file.course_code);
    const courseMember = user.role === "professor"
      ? Boolean(course && course.professor_id === user.id)
      : isEnrolled(user.id, file.course_code);
    if (!courseMember) return false;
    if (!file.encrypted) return true; // Existing plaintext materials remain available as legacy files.
    return Boolean(db.prepare("SELECT 1 FROM file_key_envelopes WHERE file_id = ? AND user_id = ?")
      .get(file.id, user.id));
  }
  if (user.role === "professor") return true;
  if (file.category === "assignment") return file.owner_id === user.id;
  if (file.category === "solution") {
    if (!file.released || !isEnrolled(user.id, file.course_code)) return false;
    return Boolean(db.prepare("SELECT 1 FROM file_key_envelopes WHERE file_id = ? AND user_id = ?")
      .get(file.id, user.id));
  }
  return false;
}
function canUploadCategory(user, category) {
  if (category === "assignment") return user.role === "student";
  if (category === "notes") return true;
  return user.role === "professor"; // solution, feedback, material
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/login", (req, res, next) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password are required." });
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ message: "Logged in.", user: req.session.user });
  });
});

// Progressive-enhancement fallback for browsers where the frontend script
// cannot run: accept the login form as a normal POST, create the same session,
// then reload the app so its existing /api/me flow renders the signed-in view.
app.post("/login", (req, res, next) => {
  const { username, password } = req.body || {};
  const user = username && password
    ? db.prepare("SELECT * FROM users WHERE username = ?").get(username)
    : null;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).type("html").send(`<!doctype html>
      <html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Login failed</title><body style="font:16px system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem">
      <h1>Login failed</h1><p>Invalid username or password.</p><p><a href="/">Return to the login page</a></p></body></html>`);
  }
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = { id: user.id, username: user.username, role: user.role };
    req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);
      res.redirect(303, "/");
    });
  });
});

app.post("/api/logout", requireLogin, (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("projectshare.sid");
    res.json({ message: "Logged out." });
  });
});

app.get("/api/me", requireLogin, (req, res) => res.json({ user: req.session.user }));

// Prototype course enrollment: the submitted roll number must match an entry
// supplied by the course professor. This does not prove ownership of that number.
app.get("/api/courses", requireLogin, (req, res) => {
  const rows = db.prepare(`SELECT c.code, c.name, u.username AS professor,
    EXISTS(SELECT 1 FROM course_enrollments e WHERE e.course_code = c.code AND e.user_id = ?) AS enrolled
    FROM courses c JOIN users u ON u.id = c.professor_id ORDER BY c.code`).all(req.session.user.id);
  res.json({ courses: rows.map(row => ({ ...row, enrolled: Boolean(row.enrolled),
    instructor: req.session.user.role === "professor" && row.professor === req.session.user.username })) });
});

app.post("/api/courses/:code/enroll", requireLogin, (req, res) => {
  if (req.session.user.role !== "student") return res.status(403).json({ error: "Only students can enroll." });
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  const rollNumber = typeof req.body?.rollNumber === "string" ? req.body.rollNumber.trim().toUpperCase() : "";
  if (!/^[A-Z0-9-]{4,20}$/.test(rollNumber)) {
    return res.status(400).json({ error: "Enter a valid roll number (4–20 letters, numbers, or hyphens)." });
  }
  const rosterMatch = db.prepare("SELECT 1 FROM course_roster WHERE course_code = ? AND roll_number = ?")
    .get(course.code, rollNumber);
  if (!rosterMatch) return res.status(403).json({ error: "That roll number is not on this course roster." });
  if (isEnrolled(req.session.user.id, course.code)) {
    return res.json({ message: "You are already enrolled.", courseCode: course.code, enrolled: true });
  }
  try {
    db.prepare("INSERT INTO course_enrollments (course_code, user_id, roll_number) VALUES (?, ?, ?)")
      .run(course.code, req.session.user.id, rollNumber);
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "This roster entry has already been used for an account." });
    }
    throw err;
  }
  res.status(201).json({ message: "Roster match found. You are enrolled.", courseCode: course.code, enrolled: true });
});

app.post("/api/courses/:code/roster", requireProfessor, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (course.professor_id !== req.session.user.id) return res.status(403).json({ error: "You do not manage this course." });
  const rawNumbers = req.body && req.body.rollNumbers;
  if (!Array.isArray(rawNumbers) || rawNumbers.length < 1 || rawNumbers.length > 1000 ||
      rawNumbers.some(value => typeof value !== "string")) {
    return res.status(400).json({ error: "Provide rollNumbers as an array of 1–1000 strings." });
  }
  const rollNumbers = [...new Set(rawNumbers.map(value => value.trim().toUpperCase()))];
  if (rollNumbers.some(value => !/^[A-Z0-9-]{4,20}$/.test(value))) {
    return res.status(400).json({ error: "Each roster entry must be 4–20 letters, numbers, or hyphens." });
  }
  const add = db.prepare("INSERT OR IGNORE INTO course_roster (course_code, roll_number) VALUES (?, ?)");
  const addAll = db.transaction(() => rollNumbers.reduce((count, number) => count + add.run(course.code, number).changes, 0));
  const added = addAll();
  res.status(201).json({ message: "Roster updated.", added, totalSubmitted: rollNumbers.length });
});

app.get("/api/courses/:code/roster", requireProfessor, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (course.professor_id !== req.session.user.id) return res.status(403).json({ error: "You do not manage this course." });
  const entries = db.prepare(`SELECT r.roll_number, e.user_id IS NOT NULL AS used
    FROM course_roster r LEFT JOIN course_enrollments e
      ON e.course_code = r.course_code AND e.roll_number = r.roll_number
    WHERE r.course_code = ? ORDER BY r.roll_number`).all(course.code)
    .map(row => ({ rollNumber: row.roll_number, used: Boolean(row.used) }));
  res.json({ courseCode: course.code, entries, rollNumbers: entries.map(entry => entry.rollNumber) });
});

app.delete("/api/courses/:code/roster/:rollNumber", requireProfessor, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (course.professor_id !== req.session.user.id) return res.status(403).json({ error: "You do not manage this course." });
  const rollNumber = req.params.rollNumber.trim().toUpperCase();
  const rosterEntry = db.prepare("SELECT 1 FROM course_roster WHERE course_code = ? AND roll_number = ?")
    .get(course.code, rollNumber);
  if (!rosterEntry) return res.status(404).json({ error: "Roster entry not found." });
  if (db.prepare("SELECT 1 FROM course_enrollments WHERE course_code = ? AND roll_number = ?")
    .get(course.code, rollNumber)) {
    return res.status(409).json({ error: "This roll number is already used by an enrolled account and cannot be removed from the roster." });
  }
  db.prepare("DELETE FROM course_roster WHERE course_code = ? AND roll_number = ?")
    .run(course.code, rollNumber);
  res.json({ message: "Roll number removed from the roster.", rollNumber });
});

app.get("/api/courses/:code/assignments", requireLogin, requireCourseEnrollment, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  const assignments = db.prepare("SELECT * FROM course_assignments WHERE course_code = ? ORDER BY deadline_at, id")
    .all(course.code);
  const isProfessor = req.session.user.role === "professor";
  const getSubmissions = db.prepare(`SELECT s.file_id, s.submitted_at, s.late_by_ms, f.original_name, u.username
    FROM assignment_submissions s JOIN files f ON f.id = s.file_id
    JOIN users u ON u.id = s.student_id WHERE s.assignment_id = ? ORDER BY u.username`);
  const getOwnSubmission = db.prepare(`SELECT s.file_id, s.submitted_at, s.late_by_ms, f.original_name
    FROM assignment_submissions s JOIN files f ON f.id = s.file_id
    WHERE s.assignment_id = ? AND s.student_id = ?`);
  const getLegacySubmissions = db.prepare(`SELECT f.id, f.original_name, f.uploaded_at, f.encrypted, u.username
    FROM files f JOIN users u ON u.id = f.owner_id
    LEFT JOIN assignment_submissions s ON s.file_id = f.id
    WHERE f.course_code = ? AND f.category = 'assignment' AND s.file_id IS NULL
      AND (? = 1 OR f.owner_id = ?) ORDER BY f.uploaded_at DESC`);
  const now = Date.now();
  const legacySubmissions = getLegacySubmissions.all(course.code, isProfessor ? 1 : 0, req.session.user.id)
    .map(row => ({ id: row.id, name: row.original_name, uploadedAt: row.uploaded_at,
      encrypted: Boolean(row.encrypted), username: row.username }));
  res.json({ assignments: assignments.map(assignment => {
    const submissions = isProfessor ? getSubmissions.all(assignment.id) : null;
    return {
      id: assignment.id,
      courseCode: assignment.course_code,
      title: assignment.title,
      deadlineAt: assignment.deadline_at,
      createdAt: assignment.created_at,
      deadlinePassed: Date.parse(assignment.deadline_at) <= now,
      submission: isProfessor ? null : (() => {
        const row = getOwnSubmission.get(assignment.id, req.session.user.id);
        return row ? { fileId: row.file_id, fileName: row.original_name, submittedAt: row.submitted_at, lateByMs: row.late_by_ms } : null;
      })(),
      submissions: submissions && submissions.map(row => ({
        fileId: row.file_id, fileName: row.original_name, submittedAt: row.submitted_at,
        lateByMs: row.late_by_ms, username: row.username
      })),
      submissionCount: submissions ? submissions.length : undefined
    };
  }), legacySubmissions });
});

app.get("/api/courses/:code/solutions", requireLogin, requireCourseEnrollment, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (req.session.user.role === "professor" && course.professor_id !== req.session.user.id) {
    return res.status(403).json({ error: "You do not manage this course." });
  }
  const rows = db.prepare(`SELECT f.*, u.username AS owner_username
    FROM files f JOIN users u ON u.id = f.owner_id
    WHERE f.course_code = ? AND f.category = 'solution' ORDER BY f.uploaded_at DESC`)
    .all(course.code);
  res.json({ solutions: rows.filter(row => canReadFile(req.session.user, row)).map(row => ({
    ...publicFileRecord(row), assignmentId: row.assignment_id
  })) });
});

app.get("/api/courses/:code/solution-recipients", requireProfessor, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (course.professor_id !== req.session.user.id) return res.status(403).json({ error: "You do not manage this course." });
  const assignmentId = Number(req.query.assignmentId);
  const assignment = Number.isSafeInteger(assignmentId) && assignmentId > 0
    ? db.prepare("SELECT id FROM course_assignments WHERE id = ? AND course_code = ?").get(assignmentId, course.code)
    : null;
  if (!assignment) return res.status(400).json({ error: "Choose a valid assignment in this course." });
  const rows = db.prepare(`SELECT u.id, u.username, k.public_key_jwk
    FROM users u LEFT JOIN user_public_keys k ON k.user_id = u.id
    WHERE u.id = ? OR u.id IN (SELECT user_id FROM course_enrollments WHERE course_code = ?)
    ORDER BY u.role, u.username`).all(req.session.user.id, course.code);
  res.json({ recipients: rows.map(row => ({ username: row.username,
    publicKey: row.public_key_jwk ? JSON.parse(row.public_key_jwk) : null })) });
});

app.get("/api/courses/:code/notes", requireLogin, requireCourseEnrollment, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (req.session.user.role === "professor" && course.professor_id !== req.session.user.id) {
    return res.status(403).json({ error: "You do not manage this course." });
  }
  const rows = db.prepare(`SELECT f.*, u.username AS owner_username
    FROM files f JOIN users u ON u.id = f.owner_id
    WHERE f.course_code = ? AND f.category = 'notes' ORDER BY f.uploaded_at DESC`)
    .all(course.code);
  res.json({ notes: rows.filter(row => canReadFile(req.session.user, row)).map(publicFileRecord) });
});

app.get("/api/courses/:code/note-recipients", requireLogin, requireCourseEnrollment, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (req.session.user.role === "professor" && course.professor_id !== req.session.user.id) {
    return res.status(403).json({ error: "You do not manage this course." });
  }
  const rows = db.prepare(`SELECT u.id, u.username, k.public_key_jwk
    FROM users u LEFT JOIN user_public_keys k ON k.user_id = u.id
    WHERE u.id = ? OR u.id IN (SELECT user_id FROM course_enrollments WHERE course_code = ?)
    ORDER BY u.role, u.username`).all(course.professor_id, course.code);
  res.json({ recipients: rows.map(row => ({ username: row.username,
    publicKey: row.public_key_jwk ? JSON.parse(row.public_key_jwk) : null })) });
});

app.get("/api/courses/:code/feedback", requireLogin, requireCourseEnrollment, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (req.session.user.role === "professor" && course.professor_id !== req.session.user.id) {
    return res.status(403).json({ error: "You do not manage this course." });
  }
  const rows = db.prepare(`SELECT f.id, f.assignment_id, a.title AS assignment_title,
      f.student_id, student.username AS student_username, f.ciphertext, f.encryption_nonce,
      f.updated_at, envelope.wrapped_key
    FROM assignment_feedback f
    JOIN course_assignments a ON a.id = f.assignment_id AND a.course_code = f.course_code
    JOIN assignment_submissions submission ON submission.assignment_id = f.assignment_id
      AND submission.student_id = f.student_id AND submission.file_id = f.submission_file_id
    JOIN users student ON student.id = f.student_id
    JOIN feedback_key_envelopes envelope ON envelope.feedback_id = f.id AND envelope.user_id = ?
    WHERE f.course_code = ? AND (? = 1 OR f.student_id = ?)
    ORDER BY a.deadline_at DESC, student.username`)
    .all(req.session.user.id, course.code, req.session.user.role === "professor" ? 1 : 0, req.session.user.id);
  res.json({ feedback: rows.map(row => ({ id: row.id, assignmentId: row.assignment_id,
    assignmentTitle: row.assignment_title, student: row.student_username,
    ciphertext: row.ciphertext, nonce: row.encryption_nonce, wrappedKey: row.wrapped_key,
    updatedAt: row.updated_at })) });
});

app.get("/api/courses/:code/feedback-recipients", requireProfessor, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (course.professor_id !== req.session.user.id) return res.status(403).json({ error: "You do not manage this course." });
  const assignmentId = Number(req.query.assignmentId);
  const assignment = Number.isSafeInteger(assignmentId) && assignmentId > 0
    ? db.prepare("SELECT id FROM course_assignments WHERE id = ? AND course_code = ?").get(assignmentId, course.code)
    : null;
  if (!assignment) return res.status(400).json({ error: "Choose a valid assignment in this course." });
  const students = db.prepare(`SELECT u.username, k.public_key_jwk
    FROM assignment_submissions s JOIN users u ON u.id = s.student_id
    LEFT JOIN user_public_keys k ON k.user_id = u.id
    WHERE s.assignment_id = ? ORDER BY u.username`).all(assignmentId);
  const professorKey = db.prepare("SELECT public_key_jwk FROM user_public_keys WHERE user_id = ?")
    .get(course.professor_id);
  res.json({ professor: { username: req.session.user.username,
    publicKey: professorKey ? JSON.parse(professorKey.public_key_jwk) : null },
    students: students.map(row => ({ username: row.username,
      publicKey: row.public_key_jwk ? JSON.parse(row.public_key_jwk) : null })) });
});

app.post("/api/courses/:code/assignments/:assignmentId/feedback", requireProfessor, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (course.professor_id !== req.session.user.id) return res.status(403).json({ error: "You do not manage this course." });
  const assignmentId = Number(req.params.assignmentId);
  const assignment = Number.isSafeInteger(assignmentId) && assignmentId > 0
    ? db.prepare("SELECT id FROM course_assignments WHERE id = ? AND course_code = ?").get(assignmentId, course.code)
    : null;
  if (!assignment) return res.status(404).json({ error: "Assignment not found in this course." });
  const { studentUsername, ciphertext, nonce, wrappedKeys } = req.body || {};
  if (typeof studentUsername !== "string" || studentUsername.length > 100) {
    return res.status(400).json({ error: "Choose a valid submitted student." });
  }
  const recipient = db.prepare(`SELECT u.id, u.username, k.public_key_jwk, s.file_id
    FROM assignment_submissions s JOIN users u ON u.id = s.student_id
    LEFT JOIN user_public_keys k ON k.user_id = u.id
    WHERE s.assignment_id = ? AND u.username = ? AND u.role = 'student'`).get(assignmentId, studentUsername);
  if (!recipient) return res.status(400).json({ error: "Choose a student who has submitted this assignment." });
  const professorKey = db.prepare("SELECT public_key_jwk FROM user_public_keys WHERE user_id = ?").get(course.professor_id);
  if (!professorKey || !recipient.public_key_jwk) {
    return res.status(409).json({ error: "The professor and submitted student must both have registered public keys." });
  }
  const decodeBase64 = value => {
    if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
    const bytes = Buffer.from(value, "base64");
    return bytes.toString("base64") === value ? bytes : null;
  };
  const nonceBytes = decodeBase64(nonce);
  const ciphertextBytes = decodeBase64(ciphertext);
  if (!nonceBytes || nonceBytes.length !== 12 || !ciphertextBytes || ciphertextBytes.length < 16 || ciphertextBytes.length > 16384 || !Array.isArray(wrappedKeys)) {
    return res.status(400).json({ error: "Encrypted feedback must include valid AES-GCM ciphertext, a 12-byte nonce, and two wrapped keys." });
  }
  const expected = new Map([[req.session.user.username, req.session.user.id], [recipient.username, recipient.id]]);
  if (wrappedKeys.length !== expected.size) return res.status(400).json({ error: "Provide wrapped keys only for the professor and submitted student." });
  const envelopes = [];
  for (const entry of wrappedKeys) {
    const wrapped = entry && decodeBase64(entry.wrappedKey);
    const userId = expected.get(entry && entry.username);
    if (!userId || !wrapped || wrapped.length !== 384 || envelopes.some(item => item.userId === userId)) {
      return res.status(400).json({ error: "Each recipient needs exactly one valid RSA-3072 wrapped AES key." });
    }
    envelopes.push({ userId, wrappedKey: entry.wrappedKey });
  }
  if (envelopes.length !== expected.size) return res.status(400).json({ error: "A wrapped AES key is required for both authorized users." });

  const feedbackId = crypto.randomUUID();
  const saveFeedback = db.transaction(() => {
    const existing = db.prepare("SELECT id FROM assignment_feedback WHERE assignment_id = ? AND student_id = ?")
      .get(assignmentId, recipient.id);
    const id = existing ? existing.id : feedbackId;
    db.prepare(`INSERT INTO assignment_feedback
      (id, course_code, assignment_id, student_id, submission_file_id, professor_id, ciphertext, encryption_nonce, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(assignment_id, student_id) DO UPDATE SET ciphertext = excluded.ciphertext,
        submission_file_id = excluded.submission_file_id, encryption_nonce = excluded.encryption_nonce,
        updated_at = CURRENT_TIMESTAMP`)
      .run(id, course.code, assignmentId, recipient.id, recipient.file_id, req.session.user.id, ciphertext, nonce);
    db.prepare("DELETE FROM feedback_key_envelopes WHERE feedback_id = ?").run(id);
    const insertEnvelope = db.prepare("INSERT INTO feedback_key_envelopes (feedback_id, user_id, wrapped_key) VALUES (?, ?, ?)");
    for (const envelope of envelopes) insertEnvelope.run(id, envelope.userId, envelope.wrappedKey);
  });
  saveFeedback();
  res.status(201).json({ message: "Encrypted grade and feedback saved for this assignment submission." });
});

app.get("/api/courses/:code/materials", requireLogin, requireCourseEnrollment, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (req.session.user.role === "professor" && course.professor_id !== req.session.user.id) {
    return res.status(403).json({ error: "You do not manage this course." });
  }
  const rows = db.prepare(`SELECT f.*, u.username AS owner_username
    FROM files f JOIN users u ON u.id = f.owner_id
    WHERE f.course_code = ? AND f.category = 'material' ORDER BY f.uploaded_at DESC`)
    .all(course.code);
  res.json({ materials: rows.filter(row => canReadFile(req.session.user, row)).map(publicFileRecord) });
});

app.get("/api/courses/:code/material-recipients", requireProfessor, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (course.professor_id !== req.session.user.id) return res.status(403).json({ error: "You do not manage this course." });
  const rows = db.prepare(`SELECT u.username, k.public_key_jwk
    FROM users u LEFT JOIN user_public_keys k ON k.user_id = u.id
    WHERE u.id = ? OR u.id IN (SELECT user_id FROM course_enrollments WHERE course_code = ?)
    ORDER BY u.role, u.username`).all(course.professor_id, course.code);
  res.json({ recipients: rows.map(row => ({ username: row.username,
    publicKey: row.public_key_jwk ? JSON.parse(row.public_key_jwk) : null })) });
});

app.post("/api/courses/:code/assignments", requireProfessor, (req, res) => {
  const course = getCourse(req.params.code);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (course.professor_id !== req.session.user.id) return res.status(403).json({ error: "You do not manage this course." });
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const deadlineMs = typeof req.body?.deadlineAt === "string" ? Date.parse(req.body.deadlineAt) : NaN;
  if (!title || title.length > 120) return res.status(400).json({ error: "Assignment title must be 1–120 characters." });
  if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
    return res.status(400).json({ error: "Deadline must be a valid future date and time." });
  }
  const result = db.prepare("INSERT INTO course_assignments (course_code, title, deadline_at, created_by) VALUES (?, ?, ?, ?)")
    .run(course.code, title, new Date(deadlineMs).toISOString(), req.session.user.id);
  res.status(201).json({ message: "Assignment created.", id: result.lastInsertRowid });
});

app.delete("/api/courses/:code/assignments/:assignmentId/submission", requireLogin, requireCourseEnrollment, (req, res) => {
  if (req.session.user.role !== "student") return res.status(403).json({ error: "Only students can withdraw a submission." });
  const assignment = db.prepare("SELECT * FROM course_assignments WHERE id = ? AND course_code = ?")
    .get(Number(req.params.assignmentId), req.params.code);
  if (!assignment) return res.status(404).json({ error: "Assignment not found." });
  if (Date.parse(assignment.deadline_at) <= Date.now()) {
    return res.status(409).json({ error: "The deadline has passed; this submission can no longer be withdrawn." });
  }
  const submission = db.prepare(`SELECT s.file_id, f.stored_name FROM assignment_submissions s
    JOIN files f ON f.id = s.file_id WHERE s.assignment_id = ? AND s.student_id = ?`)
    .get(assignment.id, req.session.user.id);
  if (!submission) return res.status(404).json({ error: "You do not have a submission to withdraw." });
  const remove = db.transaction(() => {
    db.prepare("DELETE FROM assignment_submissions WHERE assignment_id = ? AND student_id = ?")
      .run(assignment.id, req.session.user.id);
    db.prepare("DELETE FROM assignment_feedback WHERE assignment_id = ? AND student_id = ?")
      .run(assignment.id, req.session.user.id);
    db.prepare("DELETE FROM file_key_envelopes WHERE file_id = ?").run(submission.file_id);
    db.prepare("DELETE FROM files WHERE id = ?").run(submission.file_id);
  });
  remove();
  const diskPath = path.join(STORAGE_DIR, submission.stored_name);
  if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
  res.json({ message: "Submission withdrawn. You may submit again before the deadline." });
});

// Public keys are registered once. Replacing a key could strand files encrypted to it.
app.get("/api/keys/me", requireLogin, (req, res) => {
  const row = db.prepare("SELECT registered_at FROM user_public_keys WHERE user_id = ?")
    .get(req.session.user.id);
  res.json({ registered: Boolean(row), registeredAt: row ? row.registered_at : null });
});

app.put("/api/keys/me", requireLogin, (req, res) => {
  const jwk = req.body && req.body.publicKey;
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk) || jwk.kty !== "RSA" ||
      typeof jwk.n !== "string" || typeof jwk.e !== "string" || jwk.alg !== "RSA-OAEP-256" ||
      (jwk.use && jwk.use !== "enc") || !Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("encrypt") ||
      ["d", "p", "q", "dp", "dq", "qi", "oth"].some(field => Object.prototype.hasOwnProperty.call(jwk, field))) {
    return res.status(400).json({ error: "A valid RSA-OAEP-256 public JWK is required." });
  }
  try {
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength !== 3072 ||
        key.asymmetricKeyDetails.publicExponent !== 65537n) {
      return res.status(400).json({ error: "Public key must be RSA 3072-bit with exponent 65537." });
    }
  } catch (_err) {
    return res.status(400).json({ error: "Public key JWK is invalid." });
  }
  const existing = db.prepare("SELECT 1 FROM user_public_keys WHERE user_id = ?").get(req.session.user.id);
  if (existing) return res.status(409).json({ error: "A public key is already registered. Key replacement is disabled." });
  db.prepare("INSERT INTO user_public_keys (user_id, public_key_jwk) VALUES (?, ?)")
    .run(req.session.user.id, JSON.stringify(jwk));
  res.status(201).json({ message: "Public key registered." });
});

app.get("/api/keys/:username", requireLogin, (req, res) => {
  const row = db.prepare(`SELECT k.public_key_jwk, k.registered_at
    FROM user_public_keys k JOIN users u ON u.id = k.user_id WHERE u.username = ?`)
    .get(req.params.username);
  if (!row) return res.status(404).json({ error: "Registered public key not found." });
  res.json({ username: req.params.username, publicKey: JSON.parse(row.public_key_jwk), registeredAt: row.registered_at });
});

app.get("/api/assignment-recipients", requireLogin, requireCourseEnrollment, (req, res) => {
  const rows = db.prepare(`SELECT u.id, u.username, k.public_key_jwk
    FROM users u LEFT JOIN user_public_keys k ON k.user_id = u.id
    WHERE u.id = ? OR u.role = 'professor' ORDER BY u.role, u.username`)
    .all(req.session.user.id);
  res.json({ recipients: rows.map(row => ({
    username: row.username,
    publicKey: row.public_key_jwk ? JSON.parse(row.public_key_jwk) : null
  })) });
});

app.get("/api/files", requireLogin, requireCourseEnrollment, (req, res) => {
  const rows = db.prepare(`
    SELECT f.*, u.username AS owner_username
    FROM files f JOIN users u ON u.id = f.owner_id
    ORDER BY f.uploaded_at DESC
  `).all();
  const visible = rows.filter(row => canReadFile(req.session.user, row)).map(publicFileRecord);
  res.json({ files: visible });
});

app.post("/api/files", requireLogin, requireCourseEnrollment, (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const status = err instanceof multer.MulterError ? 400 : 400;
      return res.status(status).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: "Attach a file using form field 'file'." });

    const category = req.body.category;
    if (category === "feedback") {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Grades and feedback are structured records; use the assignment feedback endpoint instead of uploading a file." });
    }
    const allowedCategories = new Set(["assignment", "notes", "solution", "feedback", "material"]);
    if (!allowedCategories.has(category)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Invalid category." });
    }
    if (!canUploadCategory(req.session.user, category)) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: "Your role cannot upload this category." });
    }

    let assignmentId = null;
    let courseCode = "CS416M";
    if (category === "assignment") {
      assignmentId = Number(req.body.assignmentId);
      const assignment = Number.isSafeInteger(assignmentId) && assignmentId > 0
        ? db.prepare("SELECT id, deadline_at FROM course_assignments WHERE id = ? AND course_code = 'CS416M'").get(assignmentId)
        : null;
      if (!assignment) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: "Select a valid course assignment before submitting." });
      }
    }

    if (category === "solution") {
      courseCode = typeof req.body.courseCode === "string" ? req.body.courseCode : "";
      const course = getCourse(courseCode);
      if (!course || course.professor_id !== req.session.user.id) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: "Select a course that you manage for this solution." });
      }
      assignmentId = Number(req.body.assignmentId);
      const assignment = Number.isSafeInteger(assignmentId) && assignmentId > 0
        ? db.prepare("SELECT id FROM course_assignments WHERE id = ? AND course_code = ?").get(assignmentId, courseCode)
        : null;
      if (!assignment) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: "Select the assignment this solution belongs to." });
      }
    }

    if (category === "notes") {
      courseCode = typeof req.body.courseCode === "string" ? req.body.courseCode : "";
      const course = getCourse(courseCode);
      const canUseCourse = course && (req.session.user.role === "professor"
        ? course.professor_id === req.session.user.id
        : isEnrolled(req.session.user.id, courseCode));
      if (!canUseCourse) {
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: "You must belong to the selected course to upload notes." });
      }
    }

    let replacementFileId = null;
    let replacedStoredName = null;
    let recipientId = null;
    if (category === "feedback" || category === "material") {
      courseCode = typeof req.body.courseCode === "string" ? req.body.courseCode : "";
      const course = getCourse(courseCode);
      if (!course || course.professor_id !== req.session.user.id) {
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: "You do not manage the selected course." });
      }
      if (category === "feedback") {
        const recipient = db.prepare(`SELECT u.id FROM users u JOIN course_enrollments e ON e.user_id = u.id
          WHERE u.username = ? AND u.role = 'student' AND e.course_code = ?`)
          .get(req.body.recipientUsername || "", courseCode);
        if (!recipient) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ error: "Choose a student enrolled in this course for the feedback." });
        }
        recipientId = recipient.id;
      } else if (req.body.replaceFileId) {
        const existing = getFile(req.body.replaceFileId);
        if (!existing || existing.category !== "material" || existing.course_code !== courseCode ||
            existing.owner_id !== req.session.user.id) {
          fs.unlinkSync(req.file.path);
          return res.status(404).json({ error: "The official material to replace was not found in this course." });
        }
        replacementFileId = existing.id;
        replacedStoredName = existing.stored_name;
      }
    }

    let nonce = null;
    let keyEnvelopes = [];
    let excludedRecipientUsernames = [];
    if (["assignment", "solution", "notes", "feedback", "material"].includes(category)) {
      // Every currently supported category is encrypted in the browser before upload.
      const decodeBase64 = (value) => {
        if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
        const bytes = Buffer.from(value, "base64");
        return bytes.toString("base64") === value ? bytes : null;
      };
      const nonceBytes = decodeBase64(req.body.nonce);
      let submitted;
      try { submitted = JSON.parse(req.body.wrappedKeys || ""); } catch (_err) { submitted = null; }
      if (!nonceBytes || nonceBytes.length !== 12 || !Array.isArray(submitted)) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: "Encrypted uploads require a 12-byte AES-GCM nonce and wrapped AES keys." });
      }
      let expectedRecipients;
      if (category === "assignment") {
        expectedRecipients = db.prepare(`SELECT u.id, u.username, k.public_key_jwk
            FROM users u LEFT JOIN user_public_keys k ON k.user_id = u.id
            WHERE u.id = ? OR u.role = 'professor'`).all(req.session.user.id);
      } else if (category === "solution") {
        expectedRecipients = db.prepare(`SELECT u.id, u.username, k.public_key_jwk
            FROM users u LEFT JOIN user_public_keys k ON k.user_id = u.id
            WHERE u.id = ? OR u.id IN (SELECT user_id FROM course_enrollments WHERE course_code = ?)
            ORDER BY u.role, u.username`).all(req.session.user.id, courseCode);
      } else if (category === "notes" || category === "material") {
        const allNoteRecipients = db.prepare(`SELECT u.id, u.username, k.public_key_jwk
            FROM users u LEFT JOIN user_public_keys k ON k.user_id = u.id
            WHERE u.id = ? OR u.id IN (SELECT user_id FROM course_enrollments WHERE course_code = ?)
            ORDER BY u.role, u.username`).all(getCourse(courseCode).professor_id, courseCode);
        expectedRecipients = allNoteRecipients.filter(recipient => recipient.public_key_jwk);
        excludedRecipientUsernames = allNoteRecipients.filter(recipient => !recipient.public_key_jwk)
          .map(recipient => recipient.username);
        if (!expectedRecipients.some(recipient => recipient.id === req.session.user.id)) {
          fs.unlinkSync(req.file.path);
          return res.status(409).json({ error: `Register your public key before uploading ${category === "notes" ? "shared notes" : "official materials"}.` });
        }
      } else {
        expectedRecipients = db.prepare(`SELECT u.id, u.username, k.public_key_jwk
            FROM users u LEFT JOIN user_public_keys k ON k.user_id = u.id
            WHERE u.id = ? OR u.id = ? ORDER BY u.username`)
          .all(getCourse(courseCode).professor_id, recipientId);
      }
      const submittedByName = new Map();
      for (const item of submitted) {
        if (!item || typeof item.username !== "string" || submittedByName.has(item.username)) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ error: "Wrapped key recipient list is invalid." });
        }
        const wrapped = decodeBase64(item.wrappedKey);
        if (!wrapped || wrapped.length !== 384) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ error: "Each recipient needs a valid RSA-3072 wrapped AES key." });
        }
        submittedByName.set(item.username, item.wrappedKey);
      }
      for (const recipient of expectedRecipients) {
        if (!recipient.public_key_jwk) {
          fs.unlinkSync(req.file.path);
          return res.status(409).json({ error: `Cannot upload: ${recipient.username} has not registered a public key.` });
        }
        const wrappedKey = submittedByName.get(recipient.username);
        if (!wrappedKey) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ error: `A wrapped AES key for ${recipient.username} is required.` });
        }
        keyEnvelopes.push({ userId: recipient.id, wrappedKey });
        submittedByName.delete(recipient.username);
      }
      if (submittedByName.size) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: category === "assignment"
          ? "Wrapped keys may only be supplied for the submitting student and professor(s)."
          : category === "solution" ? "Wrapped keys may only be supplied for the professor and enrolled students."
            : category === "feedback" ? "Wrapped keys may only be supplied for the professor and designated student."
              : "Wrapped keys may only be supplied for the professor and enrolled students with registered keys." });
      }
      nonce = req.body.nonce;
    }

    const id = replacementFileId || crypto.randomUUID();
    const released = 0;
    let submissionLateByMs = 0;
    let submissionTime = null;
    try {
      const saveFile = db.transaction(() => {
        if (category === "assignment") {
          const currentAssignment = db.prepare("SELECT deadline_at FROM course_assignments WHERE id = ? AND course_code = 'CS416M'")
            .get(assignmentId);
          if (!currentAssignment) throw new Error("Assignment no longer exists.");
          const submittedAtMs = Date.now();
          const lateByMs = Math.max(0, submittedAtMs - Date.parse(currentAssignment.deadline_at));
          const previous = db.prepare(`SELECT s.file_id, f.stored_name FROM assignment_submissions s
            JOIN files f ON f.id = s.file_id WHERE s.assignment_id = ? AND s.student_id = ?`)
            .get(assignmentId, req.session.user.id);
          if (previous && lateByMs > 0) {
            const error = new Error("The deadline has passed; an existing submission can no longer be replaced.");
            error.code = "SUBMISSION_LOCKED";
            throw error;
          }
          if (previous) {
            replacedStoredName = previous.stored_name;
            db.prepare("DELETE FROM assignment_feedback WHERE assignment_id = ? AND student_id = ?")
              .run(assignmentId, req.session.user.id);
          }
          submissionTime = new Date(submittedAtMs).toISOString();
          submissionLateByMs = lateByMs;
        }
        if (category === "material" && replacementFileId) {
          db.prepare(`UPDATE files SET original_name = ?, stored_name = ?, uploaded_at = CURRENT_TIMESTAMP,
            recipient_id = NULL, released = 0, encrypted = 1, encryption_nonce = ?, course_code = ? WHERE id = ?`)
            .run(req.file.originalname, req.file.filename, nonce, courseCode, replacementFileId);
          db.prepare("DELETE FROM file_key_envelopes WHERE file_id = ?").run(replacementFileId);
        } else {
          db.prepare(`
            INSERT INTO files (id, original_name, stored_name, category, owner_id, recipient_id, released, encrypted, encryption_nonce, course_code, assignment_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(id, req.file.originalname, req.file.filename, category, req.session.user.id, recipientId, released,
            ["assignment", "solution", "notes", "feedback", "material"].includes(category) ? 1 : 0, nonce, courseCode,
            ["assignment", "solution"].includes(category) ? assignmentId : null);
        }
        const insertEnvelope = db.prepare("INSERT INTO file_key_envelopes (file_id, user_id, wrapped_key) VALUES (?, ?, ?)");
        for (const envelope of keyEnvelopes) insertEnvelope.run(id, envelope.userId, envelope.wrappedKey);
        if (category === "assignment") {
          db.prepare(`INSERT INTO assignment_submissions (assignment_id, student_id, file_id, submitted_at, late_by_ms)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(assignment_id, student_id)
            DO UPDATE SET file_id = excluded.file_id, submitted_at = excluded.submitted_at, late_by_ms = excluded.late_by_ms`)
            .run(assignmentId, req.session.user.id, id, submissionTime, submissionLateByMs);
          if (replacedStoredName) {
            const oldFile = db.prepare("SELECT id FROM files WHERE stored_name = ?").get(replacedStoredName);
            if (oldFile) {
              db.prepare("DELETE FROM file_key_envelopes WHERE file_id = ?").run(oldFile.id);
              db.prepare("DELETE FROM files WHERE id = ?").run(oldFile.id);
            }
          }
        }
      });
      saveFile();
    } catch (err) {
      fs.unlinkSync(req.file.path);
      if (err.code === "SUBMISSION_LOCKED") return res.status(409).json({ error: err.message });
      return next(err);
    }

    if (replacedStoredName) {
      const replacedPath = path.join(STORAGE_DIR, replacedStoredName);
      if (fs.existsSync(replacedPath)) fs.unlinkSync(replacedPath);
    }

    res.status(201).json({ message: category === "assignment"
      ? submissionLateByMs > 0 ? "Submission received late." : replacedStoredName ? "Submission replaced." : "Submission received on time."
      : category === "solution" ? "Encrypted solution uploaded. It is hidden from students until you release it."
      : category === "notes" || category === "material" ? excludedRecipientUsernames.length
          ? `${category === "notes" ? "Encrypted notes" : replacementFileId ? "Official material replaced" : "Official material uploaded"}. Users without registered keys were not included: ${excludedRecipientUsernames.join(", ")}.`
          : category === "notes" ? "Encrypted notes uploaded for all enrolled recipients with registered keys."
            : replacementFileId ? "Official material replaced and encrypted for current recipients."
              : "Official material uploaded and encrypted for current recipients."
          : category === "feedback" ? "Encrypted feedback uploaded for the selected student and professor."
            : "File uploaded.", id, category, name: req.file.originalname, lateByMs: submissionLateByMs,
      excludedRecipients: ["notes", "material"].includes(category) ? excludedRecipientUsernames : undefined,
      replaced: Boolean(replacementFileId) });
  });
});

app.get("/api/files/:id/download", requireLogin, (req, res) => {
  const file = getFile(req.params.id);
  if (!file) return res.status(404).json({ error: "File not found." });
  if (req.session.user.role !== "professor" && !isEnrolled(req.session.user.id, file.course_code)) {
    return res.status(403).json({ error: "Enroll in this course before accessing course files." });
  }
  if (!canReadFile(req.session.user, file)) {
    return res.status(403).json({ error: "You are not allowed to access this file." });
  }
  const diskPath = path.join(STORAGE_DIR, file.stored_name);
  if (!fs.existsSync(diskPath)) return res.status(404).json({ error: "Stored file is missing." });
  if (file.encrypted) {
    const envelope = db.prepare("SELECT wrapped_key FROM file_key_envelopes WHERE file_id = ? AND user_id = ?")
      .get(file.id, req.session.user.id);
    if (!envelope) return res.status(403).json({ error: "No encrypted key copy is available for your account." });
    res.set({
      "Cache-Control": "no-store",
      "X-ProjectShare-Nonce": file.encryption_nonce,
      "X-ProjectShare-Wrapped-Key": envelope.wrapped_key,
      "X-ProjectShare-File-Name": encodeURIComponent(file.original_name)
    });
    return res.download(diskPath, file.original_name);
  }
  res.download(diskPath, file.original_name);
});

app.post("/api/files/:id/release", requireProfessor, (req, res) => {
  const file = getFile(req.params.id);
  if (!file) return res.status(404).json({ error: "File not found." });
  if (file.category !== "solution") {
    return res.status(400).json({ error: "Only solution files can be released." });
  }
  const course = getCourse(file.course_code);
  if (!course || course.professor_id !== req.session.user.id) {
    return res.status(403).json({ error: "You do not manage this solution's course." });
  }
  if (!file.encrypted) return res.status(409).json({ error: "This legacy solution is not encrypted and cannot be released through the secure solution flow." });
  const released = req.body && req.body.released === true ? 1 : 0;
  db.prepare("UPDATE files SET released = ? WHERE id = ?").run(released, file.id);
  res.json({ message: released ? "Solution released to students." : "Solution hidden from students." });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.use(express.static(path.join(ROOT, "public"), {
  setHeaders(res, filePath) {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".html" || extension === ".js") {
      // This is a local development app; always fetch the latest frontend code.
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`IITB ProjectShare API running at http://localhost:${PORT}`);
    console.log("Demo accounts: prof / prof, stu1 / demo1, stu2 / demo2, stu3 / demo3, stu4 / demo4, stu5 / demo5");
    console.log("Development prototype only; change credentials and session secret before any deployment.");
  });
}

module.exports = { app, db };
