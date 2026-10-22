const form = document.querySelector("#auth-form");
const submitButton = document.querySelector("#submit-button");
const errorMessage = document.querySelector("#auth-error");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorMessage.hidden = true;
  submitButton.disabled = true;
  const originalLabel = submitButton.textContent;
  submitButton.textContent = form.dataset.mode === "register" ? "Creating account..." : "Signing in...";
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  try {
    const response = await fetch(`/api/auth/${form.dataset.mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = result.detail;
      const message = Array.isArray(detail)
        ? detail.map((item) => item.msg).join(" ")
        : detail || "Unable to sign in. Please try again.";
      throw new Error(message);
    }
    window.location.replace("/app");
  } catch (error) {
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = originalLabel;
  }
});
