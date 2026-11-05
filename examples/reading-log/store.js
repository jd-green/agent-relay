/* Shared localStorage data layer for Reading Log (used by index.html and, in T4, edit.html).
   Book: { id, title, author, status: "reading"|"finished", finishedDate: "YYYY-MM-DD"|"", addedAt: ms } */
(function () {
  var KEY = "readingLog.books.v1";

  function load() {
    try {
      var raw = window.localStorage.getItem(KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function save(list) {
    try { window.localStorage.setItem(KEY, JSON.stringify(list)); return true; }
    catch (e) { return false; }
  }

  function newId() {
    return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* Newest added first. Array is kept newest-first on insert; sort is stable and by addedAt desc. */
  function all() {
    return load().slice().sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
  }

  function get(id) {
    var list = load();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function add(data) {
    var list = load();
    var book = {
      id: newId(),
      title: String(data.title || "").trim(),
      author: String(data.author || "").trim(),
      status: data.status === "finished" ? "finished" : "reading",
      finishedDate: data.status === "finished" ? (data.finishedDate || "") : "",
      addedAt: Date.now()
    };
    list.unshift(book);
    return save(list) ? book : null; /* null = write failed */
  }

  function update(id, data) {
    var list = load();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        var finished = data.status === "finished";
        list[i].title = String(data.title || "").trim();
        list[i].author = String(data.author || "").trim();
        list[i].status = finished ? "finished" : "reading";
        list[i].finishedDate = finished ? (data.finishedDate || "") : "";
        return save(list) ? list[i] : null; /* null = not found or write failed */
      }
    }
    return null;
  }

  /* Returns true only when the write succeeded. */
  function remove(id) {
    var list = load().filter(function (b) { return b.id !== id; });
    return save(list);
  }

  window.BookStore = { all: all, get: get, add: add, update: update, remove: remove };
})();
