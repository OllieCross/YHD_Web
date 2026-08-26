/* runs in <head>: marks JS availability + applies saved theme before first paint */
document.documentElement.classList.add("js");
try {
  if (localStorage.getItem("yhd-theme") === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  }
} catch { /* storage blocked - keep dark default */ }
