const navToggle = document.querySelector("#nav-toggle");
const navLinks = document.querySelector("#home-nav-links");
const featureCopy = {
  answers: {
    title: "The short version, first.",
    description: "Get a direct explanation before the extra details. Ask follow-up questions whenever you need to go deeper.",
    example: "“Explain this like I’m new to the topic.”",
  },
  sources: {
    title: "Know where it came from.",
    description: "See the file and passage behind an answer, so you can revisit the original context and check the details.",
    example: "“Show me the paragraph that explains this.”",
  },
  formats: {
    title: "Bring the files you already use.",
    description: "Add PDFs, Word and PowerPoint documents, text files, or images. Scanned pages can be read with OCR.",
    example: "PDF, DOCX, PPTX, TXT, and images",
  },
};

navToggle.addEventListener("click", () => {
  const isOpen = navToggle.getAttribute("aria-expanded") === "true";
  navToggle.setAttribute("aria-expanded", String(!isOpen));
  navToggle.setAttribute("aria-label", isOpen ? "Open navigation" : "Close navigation");
  navLinks.classList.toggle("open", !isOpen);
});

navLinks.addEventListener("click", (event) => {
  if (event.target.closest("a")) {
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "Open navigation");
    navLinks.classList.remove("open");
  }
});

document.querySelectorAll(".feature-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const content = featureCopy[tab.dataset.feature];
    document.querySelectorAll(".feature-tab").forEach((item) => {
      const selected = item === tab;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-selected", String(selected));
    });
    document.querySelector("#feature-title").textContent = content.title;
    document.querySelector("#feature-description").textContent = content.description;
    const example = document.querySelector("#feature-example");
    example.replaceChildren();
    const label = document.createElement("span");
    label.textContent = tab.dataset.feature === "formats" ? "Supports" : "Try asking";
    example.append(label, document.createTextNode(` ${content.example}`));
  });
});

const revealItems = document.querySelectorAll("[data-reveal]");
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries, currentObserver) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        currentObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.14 });
  revealItems.forEach((item) => observer.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add("is-visible"));
}

async function updateAccountCta() {
  try {
    const response = await fetch("/api/auth/me");
    if (!response.ok) return;
    const { user } = await response.json();
    document.querySelectorAll(".nav-register, #hero-cta, #final-cta-link").forEach((link) => {
      link.href = "/app";
      link.textContent = "Open your workspace →";
    });
    const signIn = document.querySelector(".nav-signin");
    signIn.href = "/app";
    signIn.textContent = `Hi, ${user.display_name}`;
  } catch {
    // The public landing page remains usable if the account check is unavailable.
  }
}

updateAccountCta();
