/* Log screen */
(function () {
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var books = window.BookStore.all();
  var current = "all";
  var filterEl = document.getElementById("filter");
  var listEl = document.getElementById("list");
  var liveEl = document.getElementById("live");

  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return "";
    var mon = MONTHS[parseInt(m[2], 10) - 1];
    if (!mon) return "";
    return parseInt(m[3], 10) + " " + mon + " " + m[1];
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function emptyCard(heading, text, buttonText) {
    var d = el("div", "empty");
    d.appendChild(el("h2", null, heading));
    d.appendChild(el("p", null, text));
    if (buttonText) {
      var a = el("a", "btn btn-primary", buttonText);
      a.href = "edit.html";
      d.appendChild(a);
    } else {
      d.lastChild.style.marginBottom = "0";
    }
    return d;
  }

  function card(b) {
    var li = el("li", "book");
    var a = el("a");
    a.href = "edit.html?id=" + encodeURIComponent(b.id);
    a.appendChild(el("p", "t", b.title));
    if (b.author) a.appendChild(el("p", "a", b.author));
    var meta = el("div", "meta");
    var finished = b.status === "finished";
    meta.appendChild(el("span", "badge " + (finished ? "badge-finished" : "badge-reading"), finished ? "Finished" : "Reading"));
    if (finished && fmtDate(b.finishedDate)) meta.appendChild(el("span", null, "Finished " + fmtDate(b.finishedDate)));
    a.appendChild(meta);
    li.appendChild(a);
    return li;
  }

  function render(announce) {
    listEl.textContent = "";
    filterEl.hidden = books.length === 0;
    Array.prototype.forEach.call(filterEl.querySelectorAll("button"), function (btn) {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-filter") === current));
    });

    if (books.length === 0) {
      listEl.appendChild(emptyCard("No books yet", "Add the first book you are reading or have finished.", "Add your first book"));
      liveEl.textContent = "";
      return;
    }
    var shown = books.filter(function (b) { return current === "all" || b.status === current; });
    if (shown.length === 0) {
      listEl.appendChild(emptyCard("No books here",
        current === "reading" ? "Nothing is marked Reading right now." : "Nothing is marked Finished yet."));
    } else {
      var ul = el("ul", "books");
      shown.forEach(function (b) { ul.appendChild(card(b)); });
      listEl.appendChild(ul);
    }
    if (announce) liveEl.textContent = shown.length + (shown.length === 1 ? " book" : " books") + " shown";
  }

  filterEl.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-filter]");
    if (!btn) return;
    current = btn.getAttribute("data-filter");
    render(true);
  });

  render(false);
})();
