import { getIconSvg } from '../utils/icons.js';

export function createResumeToastElement(message) {
  const toast = document.createElement('div');
  toast.id = 'app-resume-toast';
  toast.className = 'resume-toast-pill';
  toast.innerHTML = `
    <span>${getIconSvg('check', 14)}</span>
    <span class="resume-toast-message"></span>
  `;
  toast.querySelector('.resume-toast-message').textContent = message;
  return toast;
}
