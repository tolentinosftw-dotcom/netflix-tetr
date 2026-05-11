const grid = document.querySelector("#proposalGrid");
const form = document.querySelector("#proposalForm");
const template = document.querySelector("#proposalTemplate");
const statusEl = document.querySelector("#formStatus");
const refreshButton = document.querySelector("#refreshButton");
const imageInput = document.querySelector("#imageInput");
const fileLabel = document.querySelector("#fileLabel");
const fileDrop = document.querySelector("#fileDrop");
const filePreview = document.querySelector("#filePreview");
const highlight = document.querySelector("#highlight");

let proposals = [];

function escapeText(value) {
  return String(value || "");
}

function selectedIdeaId() {
  return new URLSearchParams(window.location.search).get("idea");
}

function renderHighlight() {
  const id = selectedIdeaId();
  const idea = proposals.find((proposal) => proposal.id === id);
  if (!idea) {
    highlight.innerHTML = "";
    highlight.hidden = true;
    return;
  }

  highlight.hidden = false;
  highlight.innerHTML = `
    <img src="${idea.imageUrl}" alt="${escapeText(idea.title)}">
    <div>
      <span>Shared idea</span>
      <h3>${escapeText(idea.title)}</h3>
      <p>${escapeText(idea.reason)}</p>
    </div>
  `;
}

function renderProposals() {
  grid.innerHTML = "";
  renderHighlight();

  proposals.forEach((proposal, index) => {
    const node = template.content.cloneNode(true);
    const card = node.querySelector(".proposal-card");
    const img = node.querySelector(".proposal-image");
    const title = node.querySelector("h3");
    const reason = node.querySelector(".reason");
    const creator = node.querySelector(".creator");
    const format = node.querySelector(".format");
    const country = node.querySelector(".country");
    const voteButton = node.querySelector(".vote-button");
    const shareButton = node.querySelector(".share-button");

    card.dataset.id = proposal.id;
    if (index === 0) card.classList.add("leader");
    img.src = proposal.imageUrl;
    img.alt = proposal.title;
    title.textContent = proposal.title;
    reason.textContent = proposal.reason;
    creator.textContent = `Submitted by ${proposal.creator} - Reward: ${proposal.reward}`;
    format.textContent = proposal.format;
    country.textContent = proposal.country;
    voteButton.textContent = proposal.hasVoted ? `${proposal.votes} votes - Voted` : `${proposal.votes} votes - Vote`;
    voteButton.disabled = proposal.hasVoted;

    voteButton.addEventListener("click", () => voteFor(proposal.id, voteButton));
    shareButton.addEventListener("click", () => shareProposal(proposal));
    grid.appendChild(node);
  });
}

async function loadProposals() {
  refreshButton.disabled = true;
  try {
    const response = await fetch("/api/proposals", { credentials: "include" });
    const data = await response.json();
    proposals = data.proposals || [];
    renderProposals();
  } finally {
    refreshButton.disabled = false;
  }
}

async function voteFor(id, button) {
  button.disabled = true;
  const response = await fetch(`/api/proposals/${id}/vote`, {
    method: "POST",
    credentials: "include"
  });
  const data = await response.json();
  const proposal = proposals.find((item) => item.id === id);
  if (proposal) {
    proposal.votes = data.votes;
    proposal.hasVoted = true;
  }
  proposals.sort((a, b) => b.votes - a.votes || new Date(b.createdAt) - new Date(a.createdAt));
  renderProposals();
}

async function shareProposal(proposal) {
  const shareData = {
    title: `Vote for ${proposal.title}`,
    text: `Help bring ${proposal.title} back to Netflix as a ${proposal.format}.`,
    url: proposal.shareUrl
  };

  if (navigator.share) {
    await navigator.share(shareData);
    return;
  }

  await navigator.clipboard.writeText(proposal.shareUrl);
  statusEl.textContent = "Share link copied.";
}

function setImagePreview(file) {
  if (!file) {
    clearImagePreview();
    return;
  }

  fileLabel.textContent = file.name;
  filePreview.style.backgroundImage = `url("${URL.createObjectURL(file)}")`;
  fileDrop.classList.add("has-preview");
}

function clearImagePreview() {
  fileLabel.textContent = "Tap or drag an image";
  filePreview.style.backgroundImage = "";
  fileDrop.classList.remove("has-preview", "dragging");
}

function setDroppedFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    statusEl.textContent = "The file must be an image.";
    return;
  }

  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  imageInput.files = dataTransfer.files;
  setImagePreview(file);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusEl.textContent = "Publishing idea...";
  const submitButton = form.querySelector("button[type='submit']");
  submitButton.disabled = true;

  try {
    const response = await fetch("/api/proposals", {
      method: "POST",
      body: new FormData(form),
      credentials: "include"
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not publish the idea.");

    proposals.unshift(data.proposal);
    form.reset();
    clearImagePreview();
    statusEl.textContent = "Idea published. It now appears in the global ranking.";
    renderProposals();
    document.querySelector("#ranking").scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

imageInput.addEventListener("change", () => {
  setImagePreview(imageInput.files[0]);
});

["dragenter", "dragover"].forEach((eventName) => {
  fileDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    fileDrop.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  fileDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    fileDrop.classList.remove("dragging");
  });
});

fileDrop.addEventListener("drop", (event) => {
  setDroppedFile(event.dataTransfer.files[0]);
});

refreshButton.addEventListener("click", loadProposals);
loadProposals();
