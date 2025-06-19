let isRecording = false;
let recordedData = [];
let currentTabId = null;
let recordingDomain = null;
let initialUrlForRecording = null;


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getRecordingState") {
    sendResponse({ isRecording: isRecording, domain: recordingDomain, tabId: currentTabId });
    return true;
  } else if (request.action === "startRecording") {
    if (isRecording) {
      sendResponse({ success: false, message: "Already recording." });
      return true;
    }
    isRecording = true;
    recordedData = []; // Reset data
    currentTabId = request.tabId;
    recordingDomain = request.domain;
    initialUrlForRecording = request.initialUrl;
    lastDomEventTimestamp = null; // Reset
    lastDomEventIndex = -1;      // Reset
    pendingRequests = {};       // Reset
    awaitingEmailVerification = false;
    emailSubmissionTimestamp = null;
    lastSubmittedUsername = null;

    console.log(`Background: Start recording requested for tab ${currentTabId} on domain ${recordingDomain}`);

    // Log the initial navigation event
    recordedData.push({
      type: "navigate",
      url: initialUrlForRecording,
      timestamp: new Date().toISOString(),
      // No selector or value for initial navigation
    });
    console.log("Background: Initial navigation event logged.", recordedData);


    // Send message to content script to start listening to DOM events
    chrome.tabs.sendMessage(currentTabId, { action: "startRecordingEvents", tabId: currentTabId }, (csResponse) => {
      if (chrome.runtime.lastError) {
        console.error("Error sending startRecordingEvents to content script:", chrome.runtime.lastError.message);
        isRecording = false; // Rollback state
        currentTabId = null;
        recordingDomain = null;
        initialUrlForRecording = null;
        sendResponse({ success: false, message: "Failed to connect to content script.", error: chrome.runtime.lastError.message });
      } else if (csResponse && csResponse.status === "listening") {
        console.log("Background: Content script acknowledged start and is listening.", csResponse);
        sendResponse({ success: true, message: "Recording started on tab " + currentTabId });
      } else {
        console.warn("Background: Content script responded unexpectedly or failed to start listeners.", csResponse);
        // Even if content script fails, background might still record network.
        // Decide if this is a critical failure. For now, proceed but log.
        sendResponse({ success: true, message: "Recording started, but content script status uncertain." });
      }
    });
    return true; // Indicates that the response will be sent asynchronously

  } else if (request.action === "stopRecording") {
    if (!isRecording) {
      sendResponse({ success: false, message: "Not recording." });
      return true;
    }
    console.log("Background: Stop recording requested.");
    const wasRecording = isRecording;
    isRecording = false; // Set early to prevent new events from being logged

    if (currentTabId !== null) {
      chrome.tabs.sendMessage(currentTabId, { action: "stopRecordingEvents" }, (csResponse) => {
        if (chrome.runtime.lastError) {
          console.error("Error sending stopRecordingEvents to content script:", chrome.runtime.lastError.message);
        } else {
          console.log("Background: Content script acknowledged stop.", csResponse);
        }
      });
    }

    console.log("Background: Final recorded data:", recordedData);
    // Prepare for JSON export (to be implemented in a later step)
    // For now, just log.
    // const jsonData = JSON.stringify(recordedData, null, 2);
    // console.log(jsonData);

    // Reset state
    currentTabId = null;
    recordingDomain = null;
    initialUrlForRecording = null;
    lastDomEventTimestamp = null; // Reset
    lastDomEventIndex = -1;      // Reset
    pendingRequests = {};       // Reset
    awaitingEmailVerification = false;
    emailSubmissionTimestamp = null;
    lastSubmittedUsername = null; // Reset this too

    sendResponse({ success: true, message: "Recording stopped. Data logged to background console." });
    return true;

  } else if (request.action === "logEvent") {
    // content.js now sends tabId in the request object.
    if (isRecording && request.tabId === currentTabId) {
      const eventData = request.data;
      eventData.timestamp = new Date().toISOString(); // Standardize timestamp from background

      // Store timestamp and index for network request association
      lastDomEventTimestamp = new Date(eventData.timestamp).getTime(); // Store as ms for easy comparison
      recordedData.push(eventData); // Push event first
      lastDomEventIndex = recordedData.length - 1; // Store index of this DOM event

      if (eventData.type === 'formSubmission') {
          if (eventData.potentialEmailSubmission) {
              awaitingEmailVerification = true;
              emailSubmissionTimestamp = lastDomEventTimestamp;
              console.log("Background: Potential email submission detected. Awaiting verification URL.");
          }
          // Attempt to capture a username if submitted (simple check)
          if (eventData.formData) {
              for (const key in eventData.formData) {
                  if (key.toLowerCase().includes('user') || key.toLowerCase().includes('name') || key.toLowerCase().includes('login')) {
                      if (typeof eventData.formData[key] === 'string' && !eventData.formData[key].startsWith('***') && eventData.formData[key].length > 2) {
                          lastSubmittedUsername = eventData.formData[key];
                          console.log("Background: Captured potential username:", lastSubmittedUsername);
                          break;
                      }
                  }
              }
          }
      }

      console.log("Background: DOM Event logged from content script", eventData);
      sendResponse({success: true, status: "Event logged"});
    } else if (!isRecording) {
      console.warn("Background: Received event while not recording.", request.data);
      sendResponse({success: false, status: "Not recording"});
    } else {
      // Logged when isRecording is true but tabId doesn't match
      console.warn(`Background: Event from unexpected tab ${request.tabId} (expected ${currentTabId})`, request.data);
      sendResponse({success: false, status: "Event from wrong tab"});
    }
    return true;
  }
  // Keep other listeners like webRequest (to be detailed later)
  else if (request.action === "getRecordedData") {
    console.log("Background: getRecordedData requested. Sending data length:", recordedData.length);
    sendResponse({ success: true, data: recordedData });
    // Optional: Clear data after export if desired, but startRecording already clears it.
    // recordedData = [];
    // lastDomEventIndex = -1;
    // lastDomEventTimestamp = null;
    return true;
  }
});

let awaitingEmailVerification = false;
let emailSubmissionTimestamp = null;
const EMAIL_VERIFICATION_PATTERNS = [/verify/i, /confirm/i, /activate/i, /token=/i, /email_verified=/i, /validation/i];
const PROFILE_URL_PATTERNS = [/profile/i, /user/i, /account/i, /author/i, /dashboard/i, /settings/i];
let lastSubmittedUsername = null; // To help identify profile URLs

// Structure to hold pending network request details
let pendingRequests = {};
// Store the last DOM event timestamp for associating with network requests
let lastDomEventTimestamp = null;
let lastDomEventIndex = -1; // Index in recordedData

// --- Function to reconstruct cURL command ---
function reconstructCurl(requestDetails) {
    let curlCmd = `curl '${requestDetails.url}'`;

    // Method
    if (requestDetails.method && requestDetails.method.toUpperCase() !== 'GET') {
        curlCmd += ` -X ${requestDetails.method.toUpperCase()}`;
    }

    // Headers
    if (requestDetails.requestHeaders) {
        for (const header of requestDetails.requestHeaders) {
            curlCmd += ` -H '${header.name}: ${header.value}'`;
        }
    }

    // Body
    if (requestDetails.requestBody) {
        if (requestDetails.requestBody.formData) {
            for (const key in requestDetails.requestBody.formData) {
                requestDetails.requestBody.formData[key].forEach(value => {
                    curlCmd += ` --form '${key}=${value}'`;
                });
            }
        } else if (requestDetails.requestBody.raw && requestDetails.requestBody.raw[0] && requestDetails.requestBody.raw[0].bytes) {
            // Attempt to decode if it's text, otherwise indicate binary
            // This is a simplified approach. For actual binary data, might need more robust handling.
            try {
                const bodyStr = new TextDecoder("utf-8").decode(requestDetails.requestBody.raw[0].bytes);
                // Escape single quotes for the curl command
                curlCmd += ` --data-binary '${bodyStr.replace(/'/g, "'\\''")}'`;
            } catch (e) {
                curlCmd += ` --data-binary '@[binary_data_not_shown]'`;
            }
        }
    }
    return curlCmd;
}


// --- WebRequest Listeners ---
const WEB_REQUEST_FILTER = { urls: ["<all_urls>"] };
// const EXTRA_INFO_SPEC_REQUEST = ["requestHeaders", "extraHeaders", "requestBody"]; // For onBeforeSendHeaders, onBeforeRequest
// const EXTRA_INFO_SPEC_RESPONSE = ["responseHeaders", "extraHeaders"]; // For onCompleted

chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    if (!isRecording || details.tabId !== currentTabId || details.type === 'image' || details.type === 'stylesheet' || details.type === 'font' || details.type === 'media' || details.type === 'csp_report') {
      return;
    }
    pendingRequests[details.requestId] = {
      url: details.url,
      method: details.method,
      type: details.type,
      initiator: details.initiator,
      timeStamp: details.timeStamp, // Original timestamp
      requestBody: details.requestBody ? JSON.parse(JSON.stringify(details.requestBody)) : null // Deep copy
    };
    // console.log("onBeforeRequest:", pendingRequests[details.requestId]);
  },
  WEB_REQUEST_FILTER,
  ["requestBody"] // Need this for requestBody
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  function(details) {
    if (!pendingRequests[details.requestId]) return; // Not tracking this request

    // Filter out Chrome's internal headers for cURL reconstruction if desired
    const headers = details.requestHeaders.filter(h => !h.name.toLowerCase().startsWith('sec-ch-ua'));
    pendingRequests[details.requestId].requestHeaders = headers;
    // console.log("onBeforeSendHeaders:", details.requestId, headers);
  },
  WEB_REQUEST_FILTER,
  ["requestHeaders", "extraHeaders"] // For requestHeaders
);

chrome.webRequest.onCompleted.addListener(
  function(details) {
    if (!pendingRequests[details.requestId]) return;

    const requestData = pendingRequests[details.requestId];
    requestData.responseStatus = details.statusCode;
    requestData.responseHeaders = details.responseHeaders;
    requestData.endTimeStamp = details.timeStamp;

    const fullRequestEntry = {
      type: "networkRequest",
      requestId: details.requestId,
      ...requestData,
      curlCommand: reconstructCurl(requestData),
      responseBodySnippet: "Response body snippet not available via chrome.webRequest directly. Consider XHR interception or chrome.debugger API for full body.",
      isMainRequest: (requestData.type === 'xmlhttprequest' || requestData.type === 'form_submit' || requestData.type === 'main_frame' || requestData.type === 'sub_frame')
    };

    // Associate with last DOM event if it occurred recently
    // A window of 2 seconds for association.
    if (lastDomEventIndex !== -1 && recordedData[lastDomEventIndex] && (requestData.timeStamp - (lastDomEventTimestamp || 0) < 2000)) {
        if (!recordedData[lastDomEventIndex].associatedRequests) {
            recordedData[lastDomEventIndex].associatedRequests = [];
        }
        recordedData[lastDomEventIndex].associatedRequests.push(fullRequestEntry);
        console.log(`Background: Network request ${details.requestId} associated with DOM event index ${lastDomEventIndex}`, fullRequestEntry);
    } else {
        // Log as a standalone network event if no recent DOM event
        recordedData.push(fullRequestEntry);
        console.log(`Background: Network request ${details.requestId} logged as standalone event.`, fullRequestEntry);
    }

    delete pendingRequests[details.requestId];
  },
  WEB_REQUEST_FILTER,
  ["responseHeaders", "extraHeaders"] // For responseHeaders
);

chrome.webRequest.onErrorOccurred.addListener(
  function(details) {
    if (!pendingRequests[details.requestId]) return;

    const requestData = pendingRequests[details.requestId];
    requestData.error = details.error;
    requestData.endTimeStamp = details.timeStamp;

    const errorEntry = {
      type: "networkError",
      requestId: details.requestId,
      ...requestData,
      curlCommand: reconstructCurl(requestData) // May not be complete but useful
    };

    if (lastDomEventIndex !== -1 && recordedData[lastDomEventIndex] && (requestData.timeStamp - (lastDomEventTimestamp || 0) < 2000)) {
        if (!recordedData[lastDomEventIndex].associatedRequests) {
            recordedData[lastDomEventIndex].associatedRequests = [];
        }
        recordedData[lastDomEventIndex].associatedRequests.push(errorEntry);
    } else {
        recordedData.push(errorEntry);
    }
    console.log(`Background: Network error for ${details.requestId}: ${details.error}`, errorEntry);
    delete pendingRequests[details.requestId];
  },
  WEB_REQUEST_FILTER
);

// Listener for tab updates (e.g., URL changes)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (isRecording && tabId === currentTabId && changeInfo.url) {
    const newUrl = changeInfo.url;
    console.log(`Background: URL changed in recorded tab ${tabId} to: ${newUrl}`);
    const navTimestamp = new Date().getTime();

    // Default navigation event
    const navEventData = {
      type: "navigate",
      url: newUrl,
      timestamp: new Date(navTimestamp).toISOString()
    };
    recordedData.push(navEventData); // Log basic navigation first

    // Check for Email Verification
    if (awaitingEmailVerification && emailSubmissionTimestamp && (navTimestamp - emailSubmissionTimestamp < 300000)) { // 5 minutes window
      let isVerificationUrl = false;
      for (const pattern of EMAIL_VERIFICATION_PATTERNS) {
        if (pattern.test(newUrl)) {
          isVerificationUrl = true;
          break;
        }
      }
      if (isVerificationUrl) {
        const emailVerificationEvent = {
          type: "emailVerification",
          url: newUrl,
          timestamp: new Date(navTimestamp).toISOString(),
          message: "Automatically detected email verification URL."
        };
        recordedData.push(emailVerificationEvent);
        console.log("Background: Email verification URL detected:", newUrl);
        awaitingEmailVerification = false; // Reset flag
        emailSubmissionTimestamp = null;
      }
    }

    // Check for Final URL (Profile URL)
    let isProfileUrl = false;
    for (const pattern of PROFILE_URL_PATTERNS) {
      if (pattern.test(newUrl)) {
        isProfileUrl = true;
        break;
      }
    }
    if (isProfileUrl && lastSubmittedUsername && newUrl.toLowerCase().includes(lastSubmittedUsername.toLowerCase())) {
         // Stronger heuristic: profile pattern + contains previously submitted username
    } else if (isProfileUrl && recordedData.length > 5) {
        // Weaker heuristic: profile pattern and some interactions have happened
    } else {
        isProfileUrl = false; // Reset if heuristics not strong enough
    }

    if (isProfileUrl) {
      const finalUrlEvent = {
        type: "finalUrlCandidate",
        url: newUrl,
        timestamp: new Date(navTimestamp).toISOString(),
        detectionMethod: "Pattern match",
        matchedPattern: PROFILE_URL_PATTERNS.find(p => p.test(newUrl))?.toString(),
        contextualNote: "Further analysis or content script check might be needed to confirm selector/HTML context."
      };
      if (lastSubmittedUsername && newUrl.toLowerCase().includes(lastSubmittedUsername.toLowerCase())) {
        finalUrlEvent.detectionMethod += " (username match in URL)";
      }
      recordedData.push(finalUrlEvent);
      console.log("Background: Final URL candidate detected:", newUrl);
      // Potentially stop awaiting email verification if we land on a profile page,
      // though it's better to let email verification resolve independently.
    }
  }
});

// Placeholder for webRequest listeners
// chrome.webRequest.onBeforeRequest.addListener(...);
// chrome.webRequest.onBeforeSendHeaders.addListener(...);
// chrome.webRequest.onCompleted.addListener(...);
// chrome.webRequest.onErrorOccurred.addListener(...);

console.log("Backlink Navigator background script loaded.");
