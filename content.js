// content.js
console.log("Backlink Navigator content script loaded.");
let isActive = false;
let currentTabId = null; // Will be set by background script

// Function to generate a robust CSS selector
function getCssSelector(el) {
  if (!(el instanceof Element)) return;
  const path = [];
  while (el.nodeType === Node.ELEMENT_NODE) {
    let selector = el.nodeName.toLowerCase();
    if (el.id) {
      // Check if ID is unique
      try {
        if (document.querySelectorAll('#' + el.id.trim()).length === 1) {
          selector = '#' + el.id.trim();
          path.unshift(selector);
          break; // ID is unique, no need to go further
        } else {
           // Non-unique ID, treat it like a class or attribute for specificity
           selector += '[id="' + el.id.trim() + '"]';
        }
      } catch (e) {
        // Handle invalid characters in ID for querySelectorAll
        selector += '[id="' + el.id.trim() + '"]';
      }
    }

    const classList = Array.from(el.classList).filter(c => c.trim() !== '');
    if (classList.length > 0) {
      selector += '.' + classList.join('.');
    }

    // Add other specific attributes if necessary (e.g. name, type for inputs)
    if (el.hasAttribute('name')) {
        selector += `[name="${el.getAttribute('name')}"]`;
    }
    if (el.nodeName.toLowerCase() === 'input' && el.hasAttribute('type') && !el.id) {
        // Add type for inputs if no ID for better specificity
        selector += `[type="${el.getAttribute('type')}"]`;
    }


    let sibling = el;
    let nth = 1;
    while (sibling = sibling.previousElementSibling) {
      if (sibling.nodeName.toLowerCase() === selector.split('[')[0].split('.')[0]) nth++;
    }
    if (el.parentElement && (nth > 1 || el.parentElement.children.length > 1) && !el.id) {
       // Avoid adding :nth-of-type if there's an ID or it's the only child of its type
       // More robust to use :nth-child if possible or if selector isn't specific enough
       let childIndex = Array.from(el.parentNode.children).indexOf(el) + 1;
       selector += `:nth-child(${childIndex})`;
    }
    path.unshift(selector);
    el = el.parentNode;
    if (el === document.body || el === document.documentElement) break;
  }
  return path.join(" > ");
}

function getElementContextualHTML(el) {
    if (!el) return "";
    // Return the element's own HTML, or a snippet of its parent if it's a simple element
    return el.outerHTML.substring(0, 500); // Snippet of outerHTML
}

function isSensitiveField(element) {
    if (element.type === 'password') return true;
    if (element.hasAttribute('data-sensitive')) return true;
    // Common name attributes for sensitive fields
    const name = element.name ? element.name.toLowerCase() : '';
    const id = element.id ? element.id.toLowerCase() : '';
    if (name.includes('password') || id.includes('password')) return true;
    // Add more checks if needed, e.g., for credit card numbers, etc.
    return false;
}

function isEmailField(element) {
    if (element.type === 'email') return true;
    const name = element.name ? element.name.toLowerCase() : '';
    const id = element.id ? element.id.toLowerCase() : '';
    if (name.includes('email') || id.includes('email') || name.includes('e-mail') || id.includes('e-mail')) return true;
    return false;
}


function recordDomEvent(type, event) {
  if (!isActive) return;

  const targetElement = event.target;
  const selector = getCssSelector(targetElement);
  const contextualHtml = getElementContextualHTML(targetElement);
  let value = targetElement.value;

  if (isSensitiveField(targetElement)) {
      value = "***PASSWORD_PLACEHOLDER***";
  } else if (isEmailField(targetElement) && type === "input") {
      // Mask email only on input change, not necessarily on click if already filled
      value = "***EMAIL_PLACEHOLDER***";
  }


  const eventData = {
    type: type,
    url: window.location.href,
    selector: selector,
    tagName: targetElement.tagName,
    id: targetElement.id || '',
    class: targetElement.className || '',
    innerText: targetElement.innerText ? targetElement.innerText.substring(0, 200) : '', // Snippet
    ariaLabel: targetElement.getAttribute('aria-label') || '',
    nameAttribute: targetElement.getAttribute('name') || '',
    contextualHtmlSnippet: contextualHtml,
    isSensitive: isSensitiveField(targetElement) || (isEmailField(targetElement) && type === "input")
  };

  if (type === 'click') {
    // Specific data for clicks (already mostly covered by generic data)
  } else if (type === 'input') {
    eventData.value = value;
  } else if (type === 'selectChange') {
    eventData.value = targetElement.value;
    const selectedOption = targetElement.options[targetElement.selectedIndex];
    eventData.text = selectedOption ? selectedOption.text : '';
  } else if (type === 'formSubmission') {
    eventData.action = targetElement.action;
    eventData.method = targetElement.method;
    const formData = new FormData(targetElement);
    eventData.formData = {};
    let containsEmailField = false;
    for (let [name, val] of formData.entries()) {
      const inputElement = targetElement.elements[name];
      if (inputElement && isEmailField(inputElement)) { // isEmailField function already exists
        containsEmailField = true;
        eventData.formData[name] = "***EMAIL_PLACEHOLDER***"; // Ensure it's masked
      } else if (inputElement && isSensitiveField(inputElement)) {
        eventData.formData[name] = "***PASSWORD_PLACEHOLDER***";
      } else {
        eventData.formData[name] = val;
      }
    }
    if (containsEmailField) {
      eventData.potentialEmailSubmission = true;
    }
  }

  chrome.runtime.sendMessage({ action: "logEvent", data: eventData, tabId: currentTabId }, response => {
    if (chrome.runtime.lastError) {
      console.error("Content.js: Error logging event:", chrome.runtime.lastError.message, eventData);
    } else if (response && !response.success) {
      console.warn("Content.js: Failed to log event to background:", response.status, eventData);
    }
  });
}

// Event handlers
const handleClick = (event) => recordDomEvent('click', event);
const handleChange = (event) => {
  if (event.target.tagName === 'SELECT') {
    recordDomEvent('selectChange', event);
  } else if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
    recordDomEvent('input', event);
  }
};
const handleSubmit = (event) => recordDomEvent('formSubmission', event);

function addListeners() {
  document.addEventListener('click', handleClick, true); // Use capture phase
  document.addEventListener('change', handleChange, true); // Use capture phase for inputs/selects
  document.addEventListener('submit', handleSubmit, true); // Use capture phase for forms
  console.log("Content.js: DOM event listeners attached.");
}

function removeListeners() {
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('change', handleChange, true);
  document.removeEventListener('submit', handleSubmit, true);
  console.log("Content.js: DOM event listeners removed.");
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startRecordingEvents") {
    isActive = true;
    currentTabId = request.tabId; // Store tabId
    addListeners();
    sendResponse({ status: "listening", tabId: currentTabId });
  } else if (request.action === "stopRecordingEvents") {
    isActive = false;
    removeListeners();
    sendResponse({ status: "stopped" });
  } else if (request.action === "ping") {
    // console.log("Content script received ping from background.");
    sendResponse({ action: "pong", status: "ready" });
    return true; // Keep true if sendResponse might be async, though here it's sync.
  }
  return true;
});
