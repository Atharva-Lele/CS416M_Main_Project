"use strict";

const $ = (id) => document.getElementById(id);
const DB_NAME = "projectshare-keys";
const STORE = "identities";
let currentUser = null;
let currentCourseCode = null;
let managedCourseCode = null;
let activeAssignmentId = null;

function openKeyDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "username" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function localKey(username) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(username);
    request.onsuccess = () => { db.close(); resolve(request.result || null); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

async function saveKey(username, privateKey, publicKey) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ username, privateKey, publicKey });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function discardLocalKey(username) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(username);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers["Content-Type"] ||= "application/json";
  const response = await fetch(url, { credentials: "same-origin", ...options,
    headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function renderAuth(user) {
  currentUser = user || null;
  const signedIn = Boolean(currentUser);
  $("login-view").hidden = signedIn;
  $("workspace").classList.toggle("visible", signedIn);
  $("session").classList.toggle("visible", signedIn);
  $("session-label").textContent = signedIn ? `Logged in as ${currentUser.username}` : "";
  $("workspace-nav").hidden = !signedIn;
  $("courses-view").hidden = !signedIn;
  $("course-view").hidden = true;
  $("keys-view").hidden = true;
  $("enrollment-panel").hidden = true;
  $("roster-panel").hidden = true;
  $("assignment-create-form").hidden = !signedIn || currentUser.role !== "professor";
  $("notes-upload-form").hidden = !signedIn;
  $("material-upload-form").hidden = !signedIn || currentUser.role !== "professor";
  currentCourseCode = null;
}

async function refreshCourse() {
  if (!currentUser) return;
  const { courses } = await api("/api/courses");
  const isProfessor = currentUser.role === "professor";
  const enrolledCourses = courses.filter(course => isProfessor ? course.instructor : course.enrolled);
  const list = $("course-list");
  list.replaceChildren();
  for (const course of enrolledCourses) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "course-card";
    const name = document.createElement("strong"); name.textContent = course.name;
    const detail = document.createElement("span"); detail.textContent = `${course.code} · Open course workspace`;
    card.append(name, detail);
    card.addEventListener("click", () => openCourse(course));
    list.append(card);
  }
  $("course-empty").hidden = enrolledCourses.length > 0;
  $("course-empty").textContent = isProfessor ? "No courses are assigned to this account." : "You are not enrolled in a course yet.";
  const availableCourses = courses.filter(course => !course.enrolled && !course.instructor);
  const cs416m = availableCourses.find(course => course.code === "CS416M");
  $("enrollment-panel").hidden = isProfessor || !cs416m;
  $("enrollment-status").textContent = "A roster match enrolls this account automatically.";
  const managedCourse = courses.find(course => course.instructor);
  managedCourseCode = managedCourse ? managedCourse.code : null;
  $("roster-panel").hidden = !managedCourse;
  if (managedCourse) {
    await refreshRoster();
  }
}

async function refreshRoster() {
  if (!managedCourseCode) return;
  const { entries } = await api(`/api/courses/${encodeURIComponent(managedCourseCode)}/roster`);
  const rows = $("roster-rows"); rows.replaceChildren();
  $("roster-count").textContent = `${entries.length} roster entries`;
  if (!entries.length) {
    const row = document.createElement("tr");
    const empty = document.createElement("td"); empty.colSpan = 4; empty.className = "muted";
    empty.textContent = "No roll numbers yet. Add one below.";
    row.append(empty); rows.append(row);
    return;
  }
  entries.forEach((entry, index) => {
    const row = document.createElement("tr");
    const number = document.createElement("td"); number.className = "row-number"; number.textContent = String(index + 1);
    const roll = document.createElement("td"); roll.textContent = entry.rollNumber;
    const status = document.createElement("td"); status.className = `roster-status${entry.used ? " used" : ""}`;
    status.textContent = entry.used ? "Enrolled" : "Available";
    const actionCell = document.createElement("td");
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "roster-delete";
    remove.textContent = entry.used ? "In use" : "Remove";
    remove.disabled = entry.used;
    if (entry.used) remove.title = "This roster entry is linked to an enrolled account.";
    else remove.addEventListener("click", async () => {
      if (!confirm(`Remove ${entry.rollNumber} from the roster?`)) return;
      remove.disabled = true;
      try {
        const url = `/api/courses/${encodeURIComponent(managedCourseCode)}/roster/${encodeURIComponent(entry.rollNumber)}`;
        const result = await api(url, { method: "DELETE" });
        $("roster-status").textContent = result.message;
        await refreshRoster();
      } catch (error) {
        $("roster-status").textContent = error.message;
        remove.disabled = false;
      }
    });
    actionCell.append(remove); row.append(number, roll, status, actionCell); rows.append(row);
  });
}

function showView(view) {
  $("courses-view").hidden = view !== "courses";
  $("course-view").hidden = view !== "course";
  $("keys-view").hidden = view !== "keys";
  $("courses-nav").classList.toggle("active", view === "courses" || view === "course");
  $("keys-nav").classList.toggle("active", view === "keys");
  $("workspace-title").textContent = view === "course" ? $("course-title").textContent : view === "keys" ? "Security key" : "My courses";
  $("workspace-description").textContent = view === "course"
    ? "Course files and assignment submissions."
    : view === "keys" ? "Manage your browser-held encryption key."
      : "Choose a course to view its files and submissions.";
}

async function openCourse(course) {
  if (!currentUser || (currentUser.role !== "professor" && !course.enrolled)) return;
  currentCourseCode = course.code;
  $("course-title").textContent = course.name;
  showView("course");
  try { await Promise.all([loadAssignments(), loadNotes(), loadMaterials()]); }
  catch (error) { $("message").textContent = error.message; }
}

async function refreshStatus() {
  if (!currentUser) return null;
  const [status, local] = await Promise.all([api("/api/keys/me"), localKey(currentUser.username)]);
  $("status").textContent = status.registered
    ? `Public key registered${status.registeredAt ? ` at ${status.registeredAt}` : ""}. Private key ${local ? "is present in this browser." : "is missing from this browser."}`
    : `No public key registered. ${local ? "A local key exists; retry its registration or discard it to create a fresh key." : "No local key exists."}`;
  $("generate").disabled = status.registered || (Boolean(local) && !local.publicKey);
  $("generate").textContent = local && local.publicKey && !status.registered ? "Retry public key registration" : "Generate and register key";
  $("discard-local-key").hidden = status.registered || !local;
  return status;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "download";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatLateDuration(milliseconds) {
  let seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const units = [["day", 86400], ["hour", 3600], ["minute", 60]];
  const parts = [];
  for (const [label, size] of units) {
    const count = Math.floor(seconds / size);
    if (count) parts.push(`${count} ${label}${count === 1 ? "" : "s"}`);
    seconds %= size;
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

async function loadAssignments() {
  if (!currentUser || !currentCourseCode) return;
  const course = encodeURIComponent(currentCourseCode);
  const [assignmentData, solutionData, feedbackData] = await Promise.all([
    api(`/api/courses/${course}/assignments`),
    api(`/api/courses/${course}/solutions`),
    api(`/api/courses/${course}/feedback`)
  ]);
  const assignments = assignmentData.assignments;
  const solutions = solutionData.solutions;
  const feedbackRecords = feedbackData.feedback;
  const list = $("assignment-list"); list.replaceChildren();
  if (!assignments.length) {
    activeAssignmentId = null;
    const empty = document.createElement("p"); empty.className = "empty-files";
    empty.textContent = "No assignments have been created for this course.";
    list.append(empty);
  } else {
    if (!assignments.some(item => item.id === activeAssignmentId)) activeAssignmentId = assignments[0].id;
    const tabs = document.createElement("div"); tabs.className = "assignment-tabs";
    tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Course assignments");
    const details = document.createElement("div");
    for (const assignment of assignments) {
      const selected = assignment.id === activeAssignmentId;
      const tab = document.createElement("button"); tab.type = "button"; tab.className = "assignment-tab";
      tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(selected));
      tab.setAttribute("aria-controls", `assignment-panel-${assignment.id}`);
      tab.textContent = assignment.title;
      tab.addEventListener("click", () => {
        activeAssignmentId = assignment.id;
        for (const item of tabs.querySelectorAll("[role=tab]")) item.setAttribute("aria-selected", String(item === tab));
        for (const panel of details.children) panel.hidden = panel.id !== `assignment-panel-${assignment.id}`;
      });
      tabs.append(tab);
      const panel = document.createElement("article"); panel.className = "assignment-detail";
      panel.id = `assignment-panel-${assignment.id}`; panel.setAttribute("role", "tabpanel"); panel.hidden = !selected;
      const top = document.createElement("div"); top.className = "assignment-detail-head";
      const titleBlock = document.createElement("div");
      const meta = document.createElement("div"); meta.className = "assignment-meta";
      const deadline = document.createElement("span"); deadline.textContent = `Deadline: ${new Date(assignment.deadlineAt).toLocaleString()}`;
      const state = document.createElement("span"); state.className = "assignment-status";
      state.textContent = assignment.deadlinePassed ? "Late submissions accepted" : "Open";
      meta.append(deadline); titleBlock.append(meta); top.append(titleBlock, state); panel.append(top);

      const submissionSection = document.createElement("section"); submissionSection.className = "assignment-subsection";
      const submissionHeading = document.createElement("h4"); submissionHeading.textContent = currentUser.role === "professor" ? "Student submissions" : "Your submission";
      submissionSection.append(submissionHeading);
      if (currentUser.role === "student") {
        const submission = assignment.submission;
        const status = document.createElement("p"); status.className = "file-sub";
        status.textContent = submission
          ? `${submission.lateByMs > 0 ? `Submitted late by ${formatLateDuration(submission.lateByMs)}` : "Submitted on time"} | ${submission.fileName} | ${new Date(submission.submittedAt).toLocaleString()}`
          : "No submission yet.";
        submissionSection.append(status);
        if (submission) {
          const download = document.createElement("button"); download.type = "button"; download.textContent = "Decrypt & download submission";
          attachDownloadHandler(download, { id: submission.fileId, name: submission.fileName, encrypted: true });
          submissionSection.append(download);
        }
        if (!submission || !assignment.deadlinePassed) {
          const form = document.createElement("form"); form.className = "assignment-form";
          const label = document.createElement("label"); label.textContent = submission ? "Replace submission" : "Choose a file";
          const input = document.createElement("input"); input.type = "file"; input.required = true; label.append(input);
          const submit = document.createElement("button"); submit.type = "submit";
          submit.textContent = submission ? "Replace submission" : assignment.deadlinePassed ? "Submit late" : "Submit assignment";
          form.append(label, submit);
          form.addEventListener("submit", event => {
            event.preventDefault();
            if (input.files[0]) submitAssignment(assignment, input.files[0], submit)
              .catch(error => { $("message").textContent = error.message; });
          });
          submissionSection.append(form);
          if (submission && !assignment.deadlinePassed) {
            const withdraw = document.createElement("button"); withdraw.type = "button"; withdraw.className = "withdraw-button";
            withdraw.textContent = "Unsubmit";
            withdraw.addEventListener("click", async () => {
              withdraw.disabled = true;
              try {
                const result = await api(`/api/courses/${course}/assignments/${assignment.id}/submission`, { method: "DELETE" });
                $("message").textContent = result.message; await loadAssignments();
              } catch (error) { $("message").textContent = error.message; withdraw.disabled = false; }
            });
            submissionSection.append(withdraw);
          }
        }
      } else {
        const count = document.createElement("p"); count.className = "file-sub";
        count.textContent = `${assignment.submissionCount} submission${assignment.submissionCount === 1 ? "" : "s"}`;
        submissionSection.append(count);
        for (const submission of assignment.submissions || []) {
          const row = document.createElement("div"); row.className = "file-row";
          const info = document.createElement("span");
          info.textContent = `${submission.username} | ${submission.fileName} | ${new Date(submission.submittedAt).toLocaleString()}${submission.lateByMs > 0 ? ` | Late by ${formatLateDuration(submission.lateByMs)}` : " | On time"}`;
          const download = document.createElement("button"); download.type = "button"; download.textContent = "Decrypt & download";
          attachDownloadHandler(download, { id: submission.fileId, name: submission.fileName, encrypted: true });
          row.append(info, download); submissionSection.append(row);
        }
      }
      panel.append(submissionSection);

      const assignmentSolutions = solutions.filter(solution => solution.assignmentId === assignment.id);
      const solutionSection = document.createElement("section"); solutionSection.className = "assignment-subsection";
      const solutionHeading = document.createElement("h4"); solutionHeading.textContent = "Solution"; solutionSection.append(solutionHeading);
      if (currentUser.role === "professor") {
        const form = document.createElement("form"); form.className = "assignment-form";
        const label = document.createElement("label"); label.textContent = "Upload solution for this assignment";
        const input = document.createElement("input"); input.type = "file"; input.required = true; label.append(input);
        const upload = document.createElement("button"); upload.type = "submit"; upload.textContent = "Encrypt and upload solution";
        form.append(label, upload);
        form.addEventListener("submit", event => {
          event.preventDefault();
          if (input.files[0]) uploadSolution(assignment, input.files[0], upload).catch(error => { $("message").textContent = error.message; });
        });
        solutionSection.append(form);
      }
      if (!assignmentSolutions.length) {
        const empty = document.createElement("p"); empty.className = "empty-files";
        empty.textContent = currentUser.role === "professor" ? "No solution uploaded for this assignment." : "No solution has been released for this assignment.";
        solutionSection.append(empty);
      }
      for (const solution of assignmentSolutions) {
        const row = document.createElement("div"); row.className = "file-row";
        const info = document.createElement("div");
        const name = document.createElement("div"); name.className = "file-name"; name.textContent = solution.name;
        const detail = document.createElement("div"); detail.className = "file-sub";
        detail.textContent = `${currentUser.role === "professor" ? solution.released ? "Released to students" : "Hidden from students" : "Released"} | Uploaded ${new Date(solution.uploadedAt).toLocaleString()}`;
        info.append(name, detail);
        const actions = document.createElement("div");
        const download = document.createElement("button"); download.type = "button"; download.textContent = "Decrypt & download";
        attachDownloadHandler(download, solution);
        actions.append(download);
        if (currentUser.role === "professor") {
          const release = document.createElement("button"); release.type = "button"; release.className = "withdraw-button";
          release.textContent = solution.released ? "Hide from students" : "Release to students";
          release.addEventListener("click", async () => {
            release.disabled = true;
            try {
              const result = await api(`/api/files/${encodeURIComponent(solution.id)}/release`, {
                method: "POST", body: JSON.stringify({ released: !solution.released })
              });
              $("message").textContent = result.message; await loadAssignments();
            } catch (error) { $("message").textContent = error.message; release.disabled = false; }
          });
          actions.append(release);
        }
        row.append(info, actions); solutionSection.append(row);
      }
      panel.append(solutionSection);

      const assignmentFeedback = feedbackRecords.filter(record => record.assignmentId === assignment.id);
      const feedbackSection = document.createElement("section"); feedbackSection.className = "assignment-subsection";
      const feedbackHeading = document.createElement("h4"); feedbackHeading.textContent = "Grade and feedback";
      feedbackSection.append(feedbackHeading);
      if (currentUser.role === "professor" && assignment.submissionCount) {
        const form = document.createElement("form"); form.className = "assignment-form";
        const studentLabel = document.createElement("label"); studentLabel.textContent = "Submitted by";
        const studentSelect = document.createElement("select"); studentSelect.required = true;
        studentSelect.add(new Option("Choose a student", ""));
        const gradeLabel = document.createElement("label"); gradeLabel.textContent = "Grade";
        const gradeInput = document.createElement("input"); gradeInput.maxLength = 50; gradeInput.required = true; gradeInput.placeholder = "e.g. 18/20";
        const commentsLabel = document.createElement("label"); commentsLabel.textContent = "Comments";
        const commentsInput = document.createElement("textarea"); commentsInput.maxLength = 8000; commentsInput.required = true; commentsInput.rows = 3;
        studentLabel.append(studentSelect); gradeLabel.append(gradeInput); commentsLabel.append(commentsInput);
        const save = document.createElement("button"); save.type = "submit"; save.textContent = "Encrypt and save feedback";
        form.append(studentLabel, gradeLabel, commentsLabel, save);
        form.addEventListener("submit", event => {
          event.preventDefault();
          saveAssignmentFeedback(assignment, studentSelect.value, gradeInput.value.trim(), commentsInput.value.trim(), save)
            .catch(error => { $("message").textContent = error.message; });
        });
        feedbackSection.append(form);
        try {
          const recipientUrl = `/api/courses/${course}/feedback-recipients?assignmentId=${assignment.id}`;
          const { students } = await api(recipientUrl);
          for (const student of students) studentSelect.add(new Option(`${student.username}${student.publicKey ? " | key registered" : " | key missing"}`, student.username));
        } catch (error) {
          const problem = document.createElement("p"); problem.className = "file-sub"; problem.textContent = error.message; feedbackSection.append(problem);
        }
      } else if (currentUser.role === "professor" && !assignment.submissionCount) {
        const empty = document.createElement("p"); empty.className = "empty-files"; empty.textContent = "Feedback can be added after a student submits this assignment.";
        feedbackSection.append(empty);
      }
      if (!assignmentFeedback.length && currentUser.role === "student") {
        const empty = document.createElement("p"); empty.className = "empty-files"; empty.textContent = "No grade or feedback has been released for this assignment yet.";
        feedbackSection.append(empty);
      }
      for (const record of assignmentFeedback) {
        const row = document.createElement("div"); row.className = "assignment-entry";
        if (currentUser.role === "professor") {
          const recipient = document.createElement("strong"); recipient.textContent = record.student; row.append(recipient);
        }
        try {
          const local = await localKey(currentUser.username);
          if (!local || !local.privateKey) throw new Error("Private key is missing from this browser.");
          const rawAesKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, local.privateKey, base64ToBytes(record.wrappedKey));
          const aesKey = await crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["decrypt"]);
          const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(record.nonce), tagLength: 128 }, aesKey, base64ToBytes(record.ciphertext));
          const payload = JSON.parse(new TextDecoder().decode(plaintext));
          const grade = document.createElement("p"); grade.textContent = `Grade: ${payload.grade}`;
          const comments = document.createElement("p"); comments.textContent = payload.feedback;
          row.append(grade, comments);
        } catch (error) {
          const unavailable = document.createElement("p"); unavailable.className = "file-sub";
          unavailable.textContent = `Cannot decrypt feedback in this browser: ${error.message}`; row.append(unavailable);
        }
        feedbackSection.append(row);
      }
      panel.append(feedbackSection);
      details.append(panel);
    }
    list.append(tabs, details);
  }
    const unlinkedSolutions = solutions.filter(solution => !solution.assignmentId);
    if (unlinkedSolutions.length) {
      const legacy = document.createElement("section"); legacy.className = "assignment-subsection";
      const heading = document.createElement("h4"); heading.textContent = "Older solutions not linked to an assignment"; legacy.append(heading);
      for (const solution of unlinkedSolutions) {
        const row = document.createElement("div"); row.className = "file-row";
        const name = document.createElement("span"); name.textContent = solution.name;
        const download = document.createElement("button"); download.type = "button";
        download.textContent = solution.encrypted ? "Decrypt & download" : "Download legacy file";
        attachDownloadHandler(download, solution);
        row.append(name, download);
        if (currentUser.role === "professor" && solution.encrypted) {
          const release = document.createElement("button"); release.type = "button"; release.textContent = solution.released ? "Hide" : "Release";
          release.addEventListener("click", async () => {
            try { await api(`/api/files/${encodeURIComponent(solution.id)}/release`, { method: "POST", body: JSON.stringify({ released: !solution.released }) }); await loadAssignments(); }
            catch (error) { $("message").textContent = error.message; }
          });
          row.append(release);
        }
        legacy.append(row);
      }
      list.append(legacy);
    }
  if (assignmentData.legacySubmissions.length) {
    const legacy = document.createElement("section"); legacy.className = "assignment-subsection";
    const heading = document.createElement("h4"); heading.textContent = "Earlier submissions not linked to an assignment"; legacy.append(heading);
    for (const file of assignmentData.legacySubmissions) {
      const row = document.createElement("div"); row.className = "file-row";
      const info = document.createElement("span"); info.textContent = currentUser.role === "professor" ? `${file.username} | ${file.name} | ${file.uploadedAt}` : `${file.name} | ${file.uploadedAt}`;
      const download = document.createElement("button"); download.type = "button"; download.textContent = file.encrypted ? "Decrypt & download" : "Download legacy file";
      attachDownloadHandler(download, file);
      row.append(info, download); legacy.append(row);
    }
    list.append(legacy);
  }
}

async function uploadSolution(assignment, file, button) {
  button.disabled = true;
  $("message").textContent = "Checking course keys and encrypting the solution...";
  try {
    const url = `/api/courses/${encodeURIComponent(currentCourseCode)}/solution-recipients?assignmentId=${assignment.id}`;
    const { recipients } = await api(url);
    const encrypted = await encryptForRecipients(file, recipients);
    const form = new FormData();
    form.append("file", new Blob([encrypted.ciphertext], { type: "application/octet-stream" }), file.name);
    form.append("category", "solution"); form.append("courseCode", currentCourseCode);
    form.append("assignmentId", String(assignment.id)); form.append("nonce", encrypted.nonce);
    form.append("wrappedKeys", JSON.stringify(encrypted.wrappedKeys));
    const result = await api("/api/files", { method: "POST", body: form });
    $("message").textContent = result.message; await loadAssignments();
  } finally { button.disabled = false; }
}

async function saveAssignmentFeedback(assignment, username, grade, feedback, button) {
  if (!username || !grade || !feedback) return;
  button.disabled = true;
  try {
    const recipientUrl = `/api/courses/${encodeURIComponent(currentCourseCode)}/feedback-recipients?assignmentId=${assignment.id}`;
    const { professor, students } = await api(recipientUrl);
    const student = students.find(item => item.username === username);
    if (!student) throw new Error("Choose a student who submitted this assignment.");
    const plaintext = new TextEncoder().encode(JSON.stringify({ grade, feedback }));
    const encrypted = await encryptBytesForRecipients(plaintext, [professor, student]);
    const result = await api(`/api/courses/${encodeURIComponent(currentCourseCode)}/assignments/${assignment.id}/feedback`, {
      method: "POST", body: JSON.stringify({ studentUsername: username, ciphertext: bytesToBase64(encrypted.ciphertext),
        nonce: encrypted.nonce, wrappedKeys: encrypted.wrappedKeys })
    });
    $("message").textContent = result.message; await loadAssignments();
  } finally { button.disabled = false; }
}

async function loadNotes() {
  if (!currentUser || !currentCourseCode) return;
  const { notes } = await api(`/api/courses/${encodeURIComponent(currentCourseCode)}/notes`);
  const list = $("notes-list");
  list.replaceChildren();
  if (!notes.length) {
    const empty = document.createElement("p"); empty.className = "empty-files";
    empty.textContent = "No shared notes are available to this account yet.";
    list.append(empty);
  }
  for (const note of notes) {
    const row = document.createElement("div"); row.className = "file-row";
    const info = document.createElement("div");
    const name = document.createElement("div"); name.className = "file-name"; name.textContent = note.name;
    const detail = document.createElement("div"); detail.className = "file-sub";
    detail.textContent = `${note.encrypted ? "Encrypted" : "Legacy file · not encrypted"} · Shared by ${note.owner} · ${new Date(note.uploadedAt).toLocaleString()}`;
    info.append(name, detail);
    const download = document.createElement("button"); download.type = "button";
    download.textContent = note.encrypted ? "Decrypt & download" : "Download legacy file";
    attachDownloadHandler(download, note);
    row.append(info, download); list.append(row);
  }
}

async function loadMaterials() {
  if (!currentUser || !currentCourseCode) return;
  const { materials } = await api(`/api/courses/${encodeURIComponent(currentCourseCode)}/materials`);
  const list = $("materials-list"); list.replaceChildren();
  if (!materials.length) {
    const empty = document.createElement("p"); empty.className = "empty-files";
    empty.textContent = "No lecture materials or announcements are available yet.";
    list.append(empty);
  }
  for (const material of materials) {
    const row = document.createElement("div"); row.className = "file-row";
    const info = document.createElement("div");
    const name = document.createElement("div"); name.className = "file-name"; name.textContent = material.name;
    const detail = document.createElement("div"); detail.className = "file-sub";
    detail.textContent = `${material.encrypted ? "Encrypted" : "Legacy file · not encrypted"} · Uploaded ${new Date(material.uploadedAt).toLocaleString()}`;
    info.append(name, detail);
    const actions = document.createElement("div");
    const download = document.createElement("button"); download.type = "button";
    download.textContent = material.encrypted ? "Decrypt & download" : "Download legacy file";
    attachDownloadHandler(download, material);
    actions.append(download);
    if (currentUser.role === "professor") {
      const replaceLabel = document.createElement("label"); replaceLabel.className = "replace-material-label";
      replaceLabel.textContent = "Replace";
      const replaceInput = document.createElement("input"); replaceInput.type = "file"; replaceInput.setAttribute("aria-label", `Choose replacement file for ${material.name}`);
      replaceInput.addEventListener("change", () => {
        const replacement = replaceInput.files[0];
        if (!replacement) return;
        if (!confirm(`Replace “${material.name}” with “${replacement.name}”? The new upload will be encrypted for current course members with registered keys.`)) {
          replaceInput.value = "";
          return;
        }
        uploadMaterial(replacement, material.id, replaceInput).catch(error => { $("message").textContent = error.message; });
      });
      replaceLabel.append(replaceInput); actions.append(replaceLabel);
    }
    row.append(info, actions); list.append(row);
  }
}

async function confirmMissingRecipients(recipients, purpose) {
  const missing = recipients.filter(recipient => !recipient.publicKey).map(recipient => recipient.username);
  if (!missing.length) return true;
  return confirm(`These course members have not registered public keys and will not be able to open this ${purpose}:\n\n${missing.join(", ")}\n\nContinue for members with registered keys only?`);
}

async function uploadMaterial(file, replaceFileId, input) {
  if (!currentUser || currentUser.role !== "professor" || !currentCourseCode) return;
  if (input) input.disabled = true;
  else $("material-upload-submit").disabled = true;
  try {
    const { recipients } = await api(`/api/courses/${encodeURIComponent(currentCourseCode)}/material-recipients`);
    if (!recipients.some(recipient => recipient.username === currentUser.username && recipient.publicKey)) {
      throw new Error("The professor must register a public key before uploading official materials.");
    }
    if (!await confirmMissingRecipients(recipients, "official material")) {
      if (input) input.value = ""; else $("material-upload-form").reset();
      return;
    }
    const encrypted = await encryptForRecipients(file, recipients.filter(recipient => recipient.publicKey));
    const form = new FormData();
    form.append("file", new Blob([encrypted.ciphertext], { type: "application/octet-stream" }), file.name);
    form.append("category", "material");
    form.append("courseCode", currentCourseCode);
    form.append("nonce", encrypted.nonce);
    form.append("wrappedKeys", JSON.stringify(encrypted.wrappedKeys));
    if (replaceFileId) form.append("replaceFileId", replaceFileId);
    const result = await api("/api/files", { method: "POST", body: form });
    if (input) input.value = ""; else $("material-upload-form").reset();
    $("message").textContent = result.message;
    await loadMaterials();
  } finally {
    if (input) input.disabled = false;
    else $("material-upload-submit").disabled = false;
  }
}

async function encryptForRecipients(file, recipients) {
  return encryptBytesForRecipients(new Uint8Array(await file.arrayBuffer()), recipients);
}

async function encryptBytesForRecipients(plaintext, recipients) {
  const missing = recipients.filter(recipient => !recipient.publicKey).map(recipient => recipient.username);
  if (missing.length) throw new Error(`Cannot upload until public keys are registered for: ${missing.join(", ")}.`);
  const local = await localKey(currentUser.username);
  if (!local || !local.privateKey || !local.publicKey) {
    throw new Error("Your private key is not available in this browser. Upload from the browser where your key was generated.");
  }
  const ownPublicKey = recipients.find(recipient => recipient.username === currentUser.username)?.publicKey;
  if (!ownPublicKey || ownPublicKey.n !== local.publicKey.n || ownPublicKey.e !== local.publicKey.e) {
    throw new Error("The private key in this browser does not match your registered public key. Upload is blocked.");
  }
  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext);
  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
  const wrappedKeys = [];
  for (const recipient of recipients) {
    const publicKey = await crypto.subtle.importKey("jwk", recipient.publicKey,
      { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    const wrappedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawAesKey);
    wrappedKeys.push({ username: recipient.username, wrappedKey: bytesToBase64(wrappedKey) });
  }
  return { ciphertext, nonce: bytesToBase64(nonce), wrappedKeys };
}

async function submitAssignment(assignment, file, button) {
  button.disabled = true;
  $("message").textContent = "Checking recipient keys...";
  try {
    const { recipients } = await api("/api/assignment-recipients");
    const encrypted = await encryptForRecipients(file, recipients);

    const form = new FormData();
    form.append("file", new Blob([encrypted.ciphertext], { type: "application/octet-stream" }), file.name);
    form.append("category", "assignment");
    form.append("assignmentId", String(assignment.id));
    form.append("nonce", encrypted.nonce);
    form.append("wrappedKeys", JSON.stringify(encrypted.wrappedKeys));
    const result = await api("/api/files", { method: "POST", body: form });
    $("message").textContent = result.message;
    await loadAssignments();
  } finally {
    button.disabled = false;
  }
}

$("notes-upload-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUser || !currentCourseCode) return;
  const file = $("notes-file").files[0];
  if (!file) return;
  const button = $("notes-upload-submit"); button.disabled = true;
  $("message").textContent = "Checking course members' keys and encrypting the notes...";
  try {
    const { recipients } = await api(`/api/courses/${encodeURIComponent(currentCourseCode)}/note-recipients`);
    const missing = recipients.filter(recipient => !recipient.publicKey).map(recipient => recipient.username);
    if (!recipients.some(recipient => recipient.username === currentUser.username && recipient.publicKey)) {
      throw new Error("Register your public key before uploading shared notes.");
    }
    if (missing.length && !confirm(`These course members have not registered public keys and will not be able to open this upload:\n\n${missing.join(", ")}\n\nUpload for members with registered keys only?`)) {
      $("message").textContent = "Upload cancelled. Ask those users to register keys, then try again.";
      return;
    }
    const encrypted = await encryptForRecipients(file, recipients.filter(recipient => recipient.publicKey));
    const form = new FormData();
    form.append("file", new Blob([encrypted.ciphertext], { type: "application/octet-stream" }), file.name);
    form.append("category", "notes");
    form.append("courseCode", currentCourseCode);
    form.append("nonce", encrypted.nonce);
    form.append("wrappedKeys", JSON.stringify(encrypted.wrappedKeys));
    const result = await api("/api/files", { method: "POST", body: form });
    $("notes-upload-form").reset();
    $("message").textContent = result.message;
    await loadNotes();
  } catch (error) { $("message").textContent = error.message; }
  finally { button.disabled = false; }
});

$("material-upload-form").addEventListener("submit", async event => {
  event.preventDefault();
  const file = $("material-file").files[0];
  if (!file) return;
  try { await uploadMaterial(file, null, null); }
  catch (error) { $("message").textContent = error.message; }
});

function attachDownloadHandler(button, file) {
  button.addEventListener("click", async () => {
    const row = button.closest(".file-row") || button.parentElement;
    row.querySelectorAll(".download-error").forEach(message => message.remove());
    row.classList.remove("has-download-error");
    button.disabled = true;
    try {
      await downloadAssignment(file);
    } catch (error) {
      const message = document.createElement("p");
      message.className = "download-error";
      message.setAttribute("role", "alert");
      message.textContent = `Could not decrypt or download this file: ${error.message}`;
      row.append(message);
      row.classList.add("has-download-error");
      message.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } finally {
      button.disabled = false;
    }
  });
}

async function downloadAssignment(file) {
  const response = await fetch(`/api/files/${encodeURIComponent(file.id)}/download`, { credentials: "same-origin" });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new Error(problem.error || `Download failed (${response.status}).`);
  }
  const filename = decodeURIComponent(response.headers.get("X-ProjectShare-File-Name") || encodeURIComponent(file.name));
  if (!file.encrypted) {
    saveBlob(await response.blob(), filename);
    return;
  }
  const local = await localKey(currentUser.username);
  if (!local || !local.privateKey) throw new Error("Your private key is not available in this browser, so this file cannot be decrypted here.");
  const wrapped = base64ToBytes(response.headers.get("X-ProjectShare-Wrapped-Key"));
  const nonce = base64ToBytes(response.headers.get("X-ProjectShare-Nonce"));
  const rawAesKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, local.privateKey, wrapped);
  const aesKey = await crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const ciphertext = await response.arrayBuffer();
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, ciphertext);
  saveBlob(new Blob([plaintext]), filename);
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("login-submit");
  const loginMessage = $("login-message");
  button.disabled = true;
  button.textContent = "Signing in…";
  loginMessage.hidden = true;
  loginMessage.textContent = "";
  $("message").textContent = "";
  try {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timeoutId;
    const request = api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: $("username").value, password: $("password").value }),
      ...(controller ? { signal: controller.signal } : {})
    });
    const timeout = new Promise((_resolve, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        reject(new Error("Login timed out: the server did not finish responding to POST /api/login."));
      }, 15000);
    });
    let result;
    try { result = await Promise.race([request, timeout]); }
    finally { window.clearTimeout(timeoutId); }
    button.disabled = false;
    button.textContent = "Log in";
    $("password").value = "";
    renderAuth(result.user);
    try {
      const keyStatus = await refreshStatus();
      await refreshCourse();
      showView(keyStatus.registered ? "courses" : "keys");
      $("message").textContent = "";
    } catch (error) {
      showView("courses");
      $("message").textContent = `Signed in, but could not load account data: ${error.message}`;
    }
  } catch (error) {
    loginMessage.textContent = error.message || "Could not reach the server. Check the connection and try again.";
    loginMessage.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Log in";
  }
});

// Web Crypto and IndexedDB require a secure browser context for key operations.
// Login remains available, but an HTTP LAN address cannot provide those features.
if (!window.isSecureContext || !window.crypto || !window.crypto.subtle || !window.indexedDB) {
  const warning = $("connection-warning");
  warning.textContent = "This page is not running in a secure browser context. Login may work, but key generation and encrypted file operations require HTTPS (localhost is allowed for development). Avoid entering real credentials over plain HTTP.";
  warning.hidden = false;
}

$("logout").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); }
  catch (error) { $("message").textContent = error.message; return; }
  renderAuth(null);
  $("status").textContent = "Log in to check key status.";
  $("assignment-list").replaceChildren();
  $("message").textContent = "Logged out.";
});

$("generate").addEventListener("click", async () => {
  if (!currentUser) return;
  $("generate").disabled = true;
  try {
    const [status, local] = await Promise.all([api("/api/keys/me"), localKey(currentUser.username)]);
    if (status.registered) throw new Error("A key is already registered. Replacement is disabled.");
    let publicKey;
    if (local) {
      if (!local.publicKey) throw new Error("A local private key exists without registration data. Do not generate a replacement.");
      publicKey = local.publicKey;
    } else {
      const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 3072,
        publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, false, ["encrypt", "decrypt"]);
      publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
      await saveKey(currentUser.username, pair.privateKey, publicKey);
    }
    await api("/api/keys/me", { method: "PUT", body: JSON.stringify({ publicKey }) });
    $("message").textContent = "Key generated and public key registered.";
    await refreshStatus();
    showView("courses");
  } catch (error) {
    $("message").textContent = error.message;
    await refreshStatus().catch(() => {});
  }
});

$("discard-local-key").addEventListener("click", async () => {
  if (!currentUser) return;
  const confirmed = confirm("Discard this browser's local key for this account? Files encrypted to it may become unrecoverable.");
  if (!confirmed) return;
  try {
    await discardLocalKey(currentUser.username);
    $("message").textContent = "Local key discarded. You can now generate and register a fresh key.";
    await refreshStatus();
  } catch (error) {
    $("message").textContent = error.message;
  }
});

// Restore the signed-in layout when the page is refreshed with a valid session cookie.
api("/api/me").then(({ user }) => {
  renderAuth(user);
  return Promise.all([refreshStatus(), refreshCourse()]).then(([keyStatus]) => {
    showView(keyStatus.registered ? "courses" : "keys");
  });
}).catch(() => renderAuth(null));

$("courses-nav").addEventListener("click", () => showView("courses"));
$("keys-nav").addEventListener("click", () => showView("keys"));
$("back-courses").addEventListener("click", () => showView("courses"));

$("enrollment-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("enrollment-submit");
  button.disabled = true;
  try {
    const result = await api("/api/courses/CS416M/enroll", {
      method: "POST", body: JSON.stringify({ rollNumber: $("roll-number").value })
    });
    $("message").textContent = result.message;
    await refreshCourse();
  } catch (error) {
    $("message").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("roster-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!managedCourseCode) return;
  const button = $("roster-submit");
  button.disabled = true;
  try {
    const rollNumber = $("roster-number").value.trim();
    const url = `/api/courses/${encodeURIComponent(managedCourseCode)}/roster`;
    const result = await api(url, {
      method: "POST", body: JSON.stringify({ rollNumbers: [rollNumber] })
    });
    $("roster-form").reset();
    $("roster-status").textContent = result.added ? "Roll number added to the roster." : "That roll number is already on the roster.";
    await refreshRoster();
  } catch (error) {
    $("roster-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("assignment-create-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUser || currentUser.role !== "professor" || !currentCourseCode) return;
  const button = $("assignment-create-submit");
  button.disabled = true;
  try {
    const deadlineAt = new Date($("assignment-deadline").value);
    if (!Number.isFinite(deadlineAt.getTime())) throw new Error("Choose a valid assignment deadline.");
    const url = "/api/courses/" + encodeURIComponent(currentCourseCode) + "/assignments";
    const result = await api(url, { method: "POST", body: JSON.stringify({ title: $("assignment-title").value, deadlineAt: deadlineAt.toISOString() }) });
    $("assignment-create-form").reset();
    $("message").textContent = result.message;
    await loadAssignments();
  } catch (error) {
    $("message").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
