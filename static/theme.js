const themeStorageKey = "mydocx-theme";
const themeToggles = document.querySelectorAll(".theme-toggle");

function setTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.dataset.theme = theme;
  document.body.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = isDark ? "#111722" : "#EBE2CC";
  themeToggles.forEach((toggle) => {
    toggle.setAttribute("aria-pressed", String(isDark));
    toggle.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} mode`);
    toggle.title = `Switch to ${isDark ? "light" : "dark"} mode`;
  });
}

setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");

themeToggles.forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    setTheme(theme);
    try {
      localStorage.setItem(themeStorageKey, theme);
    } catch (error) {
      console.warn("Could not save the theme preference.", error);
    }
  });
});
