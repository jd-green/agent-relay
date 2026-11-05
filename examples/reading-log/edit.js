/* Add/Edit screen. Add mode: edit.html. Edit mode: edit.html?id=<id> */
(function () {
  var store = window.BookStore;
  var $ = function (id) { return document.getElementById(id); };
  var id = new URLSearchParams(window.location.search).get("id");
  var book = id ? store.get(id) : null;

  if (id && !book) {
    $("editor").hidden = true;
    $("notfound").hidden = false;
    document.title = "Book not found - Reading Log";
    return;
  }

  var title = $("title"), author = $("author"), status = $("status"), date = $("date");
  var dateField = $("date-field"), err = $("title-err");
  var confirmEl = $("confirm"), delBtn = $("delete-btn");

  function today() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function syncDate(switched) {
    var finished = status.value === "finished";
    dateField.hidden = !finished;
    if (!finished) date.value = "";
    else if (switched && !date.value) date.value = today();
  }

  if (book) {
    $("heading").textContent = "Edit book";
    document.title = "Edit book - Reading Log";
    title.value = book.title;
    author.value = book.author || "";
    status.value = book.status === "finished" ? "finished" : "reading";
    date.value = book.finishedDate || "";
    $("delete-zone").hidden = false;
  }
  syncDate(false);

  status.addEventListener("change", function () { syncDate(true); });

  var saveErr = $("save-err"), deleteErr = $("delete-err");
  function showAlert(region, text) {
    region.textContent = "";
    var p = document.createElement("p");
    p.className = "err";
    p.textContent = text;
    region.appendChild(p);
  }
  function clearAlerts() { saveErr.textContent = ""; deleteErr.textContent = ""; }

  function clearError() {
    err.hidden = true;
    title.removeAttribute("aria-invalid");
  }
  title.addEventListener("input", function () { clearError(); clearAlerts(); });
  author.addEventListener("input", clearAlerts);
  status.addEventListener("change", clearAlerts);
  date.addEventListener("input", clearAlerts);

  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!title.value.trim()) {
      err.hidden = false;
      title.setAttribute("aria-invalid", "true");
      title.focus();
      return;
    }
    var data = { title: title.value, author: author.value, status: status.value, finishedDate: date.value };
    clearAlerts();
    var saved = book ? store.update(book.id, data) : store.add(data);
    if (!saved) {
      /* Write failed: stay on the form with the entered data. */
      showAlert(saveErr, "Couldn't save. Your browser storage may be full. Your changes are still on this page.");
      return;
    }
    window.location.href = "index.html";
  });

  if (book) {
    function closeConfirm() {
      deleteErr.textContent = "";
      confirmEl.hidden = true;
      delBtn.hidden = false;
      delBtn.focus();
    }
    delBtn.addEventListener("click", function () {
      $("confirm-msg").textContent = "Delete “" + book.title + "”? This can’t be undone.";
      delBtn.hidden = true;
      confirmEl.hidden = false;
      confirmEl.focus();
    });
    $("keep-btn").addEventListener("click", closeConfirm);
    $("yes-btn").addEventListener("click", function () {
      deleteErr.textContent = "";
      if (!store.remove(book.id)) {
        showAlert(deleteErr, "Couldn't delete this book. Your browser storage may be unavailable.");
        return;
      }
      window.location.href = "index.html";
    });
    confirmEl.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); closeConfirm(); }
    });
  }
})();
