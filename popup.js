document.addEventListener('DOMContentLoaded', function() {
  const recordButton = document.getElementById('recordButton');
  const statusIndicator = document.getElementById('statusIndicator');
  const recordingDomainDisplay = document.getElementById('recordingDomain');

  // Function to update UI based on recording state
  function updateUI(isRecording, domain) {
    if (isRecording) {
      recordButton.textContent = 'Stop Recording';
      recordButton.classList.add('recording'); // Add class for styling
      statusIndicator.textContent = 'Status: Recording...';
      if (domain) {
        recordingDomainDisplay.textContent = `On: ${domain}`;
      } else {
        recordingDomainDisplay.textContent = 'Getting domain...';
      }
    } else {
      recordButton.textContent = 'Record';
      recordButton.classList.remove('recording'); // Remove class
      statusIndicator.textContent = 'Status: Idle';
      recordingDomainDisplay.textContent = '';
    }
  }

  // Check initial recording state when popup opens
  chrome.runtime.sendMessage({ action: "getRecordingState" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error getting initial state:", chrome.runtime.lastError.message);
      updateUI(false); // Assume not recording if error
      return;
    }
    if (response) {
      updateUI(response.isRecording, response.domain);
    } else {
      // background.js might not be ready yet on first install
      updateUI(false);
    }
  });

  recordButton.addEventListener('click', () => {
    // Request the current state again to ensure we have the latest
    chrome.runtime.sendMessage({ action: "getRecordingState" }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("Error getting state before toggle:", chrome.runtime.lastError.message);
        // Optionally, show an error to the user in the popup
        statusIndicator.textContent = "Error, please try again.";
        return;
      }

      const currentlyRecording = response ? response.isRecording : false;

      if (!currentlyRecording) {
        // Start recording
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length === 0) {
            statusIndicator.textContent = 'Error: No active tab.';
            return;
          }
          const currentTab = tabs[0];
          const domain = new URL(currentTab.url).hostname;
          updateUI(true, domain); // Optimistically update UI

          chrome.runtime.sendMessage({ action: "startRecording", tabId: currentTab.id, initialUrl: currentTab.url, domain: domain }, (startResponse) => {
            if (chrome.runtime.lastError || !startResponse || !startResponse.success) {
              console.error("Error starting recording:", chrome.runtime.lastError ? chrome.runtime.lastError.message : "No response or failed");
              statusIndicator.textContent = 'Error starting.';
              updateUI(false); // Revert UI
            } else {
              // Successfully started
              console.log("Recording started successfully on background.");
            }
          });
        });
      } else {
        // Stop recording
        chrome.runtime.sendMessage({ action: "stopRecording" }, (stopResponse) => {
          if (chrome.runtime.lastError || !stopResponse || !stopResponse.success) {
            console.error("Error stopping recording:", chrome.runtime.lastError ? chrome.runtime.lastError.message : "No response or failed");
            statusIndicator.textContent = 'Error stopping.';
            // UI might be out of sync, re-query state or update based on expected state
          } else {
            updateUI(false); // Update UI to idle
            console.log("Recording stopped successfully on background.");

                // ---- ADD JSON EXPORT LOGIC ----
                statusIndicator.textContent = 'Status: Preparing download...';
                chrome.runtime.sendMessage({ action: "getRecordedData" }, (dataResponse) => {
                  if (chrome.runtime.lastError) {
                    console.error("Error getting recorded data:", chrome.runtime.lastError.message);
                    statusIndicator.textContent = 'Error fetching data for download.';
                    return;
                  }
                  if (dataResponse && dataResponse.data) {
                    const jsonData = JSON.stringify(dataResponse.data, null, 2);
                    const blob = new Blob([jsonData], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    a.href = url;
                    a.download = `backlink_process_${timestamp}.json`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    statusIndicator.textContent = 'Status: Idle. Data exported.';
                    console.log("Data exported to JSON file.");
                  } else {
                    statusIndicator.textContent = 'Status: No data to export.';
                    console.log("No data received for export.");
                  }
                });
                // ---- END JSON EXPORT LOGIC ----
          }
        });
      }
    });
  });
});
