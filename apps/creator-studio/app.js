'use strict';
const fileInput = document.getElementById('media-file');
const chooseButton = document.getElementById('choose-file');
const fileStatus = document.getElementById('file-status');
const saveButton = document.getElementById('save-draft');
const caption = document.getElementById('caption');
const draftStatus = document.getElementById('draft-status');
let selectedFile = null;
if (chooseButton && fileInput) chooseButton.addEventListener('click', () => fileInput.click());
if (fileInput) fileInput.addEventListener('change', () => {
  selectedFile = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
  if (!fileStatus) return;
  if (!selectedFile) { fileStatus.textContent = 'No media selected.'; return; }
  const mb = (selectedFile.size / 1024 / 1024).toFixed(2);
  fileStatus.textContent = selectedFile.name + ' · ' + mb + ' MB · selected locally; not uploaded.';
});
if (saveButton && caption) {
  try { caption.value = localStorage.getItem('zuno:studio-draft') || ''; } catch (_) {}
  saveButton.addEventListener('click', () => {
    try {
      localStorage.setItem('zuno:studio-draft', JSON.stringify({ caption: caption.value, filename: selectedFile ? selectedFile.name : null, savedAt: new Date().toISOString() }));
      if (draftStatus) draftStatus.textContent = 'Local draft saved. No file was uploaded and no post was published.';
    } catch (_) {
      if (draftStatus) draftStatus.textContent = 'Draft could not be saved in this browser.';
    }
  });
}
