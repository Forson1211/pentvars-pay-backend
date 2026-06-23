let activeSessionId = null;
let serviceCode = '';
let phoneNumber = '+233244123456';
let textState = '';
let currentInputMode = true; // true = CON, false = END

// Auto-update phone status bar time
function updatePhoneTime() {
    const timeDisplay = document.getElementById('phone-time');
    if (!timeDisplay) return;
    const now = new Date();
    let hours = now.getHours();
    let minutes = now.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    minutes = minutes < 10 ? '0' + minutes : minutes;
    timeDisplay.textContent = hours + ':' + minutes + ' ' + ampm;
}
setInterval(updatePhoneTime, 1000);

// Keypad handlers
function pressKey(char) {
    const display = document.getElementById('number-input');
    if (display) {
        display.textContent += char;
    }
    playClickSound();
}

function deleteDigit() {
    const display = document.getElementById('number-input');
    if (display) {
        display.textContent = display.textContent.slice(0, -1);
    }
}

function playClickSound() {
    try {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.connect(gain);
        gain.connect(context.destination);
        osc.frequency.setValueAtTime(600, context.currentTime);
        gain.gain.setValueAtTime(0.05, context.currentTime);
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.08);
        osc.stop(context.currentTime + 0.1);
    } catch (e) {}
}

// Logger helpers
function logMessage(type, message, details = '') {
    const logsContainer = document.getElementById('logs-container');
    if (!logsContainer) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString() + '.' + String(now.getMilliseconds()).padStart(3, '0');
    
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    
    const timeDiv = document.createElement('div');
    timeDiv.className = 'log-time';
    timeDiv.textContent = `[${timeStr}] - ${type.toUpperCase()}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'log-content';
    contentDiv.textContent = message;
    if (details) {
        contentDiv.textContent += '\n' + JSON.stringify(details, null, 2);
    }
    
    entry.appendChild(timeDiv);
    entry.appendChild(contentDiv);
    logsContainer.appendChild(entry);
    logsContainer.scrollTop = logsContainer.scrollHeight;
}

function clearLogs() {
    const logsContainer = document.getElementById('logs-container');
    if (logsContainer) {
        logsContainer.innerHTML = '';
    }
}

// Dialog state
function showDialog(message, isInputNeeded = true) {
    const overlay = document.getElementById('ussd-dialog');
    const msgDiv = document.getElementById('ussd-message');
    const input = document.getElementById('ussd-input');
    const sendBtn = document.getElementById('send-btn');
    
    if (msgDiv) msgDiv.textContent = message;

    if (overlay) {
        // Two-step rAF technique: set display:flex first, then add .active on the
        // next frame so the browser has one layout pass to register opacity:0 before
        // transitioning to opacity:1. Without this, display:none → display:flex
        // collapses into a single paint and the CSS transition never fires.
        overlay.style.display = 'flex';
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                overlay.classList.add('active');
            });
        });
    }
    
    currentInputMode = isInputNeeded;
    if (isInputNeeded) {
        if (input) {
            input.style.display = 'block';
            input.value = '';
            setTimeout(() => input.focus(), 150);
        }
        if (sendBtn) sendBtn.textContent = 'Send';
    } else {
        if (input) input.style.display = 'none';
        if (sendBtn) sendBtn.textContent = 'OK';
    }
}

function hideDialog() {
    const overlay = document.getElementById('ussd-dialog');
    if (overlay) {
        overlay.classList.remove('active');
        // Wait for the fade-out transition to finish, then truly hide the element
        // so it can never accidentally block clicks on the dial buttons.
        const onFadeOut = function () {
            overlay.removeEventListener('transitionend', onFadeOut);
            if (!overlay.classList.contains('active')) {
                overlay.style.display = 'none';
            }
        };
        overlay.addEventListener('transitionend', onFadeOut);
    }
}

function cancelSession() {
    hideDialog();
    logMessage('info', 'Session cancelled by user.');
    activeSessionId = null;
    textState = '';
}

// USSD Gateway API Communication
async function initiateUSSDCall() {
    const display = document.getElementById('number-input');
    const dialDisplay = display ? display.textContent.trim() : '';
    if (!dialDisplay) return;
    
    // Read custom SIM phone number from settings
    const simPhoneInput = document.getElementById('sim-phone') || document.getElementById('sim-phone-visible');
    let rawPhone = simPhoneInput ? simPhoneInput.value.trim() : '';
    
    if (!rawPhone) {
        showDialog('Please enter a SIM Number at the bottom first.', false);
        return;
    }

    if (rawPhone.startsWith('0')) {
        phoneNumber = '+233' + rawPhone.substring(1);
    } else if (rawPhone.startsWith('+')) {
        phoneNumber = rawPhone;
    } else {
        phoneNumber = '+233' + rawPhone;
    }
    
    serviceCode = dialDisplay;
    activeSessionId = 'sim-' + Math.floor(Math.random() * 100000000);
    textState = '';
    
    showDialog('Connecting USSD...');
    await makeUSSDRequest();
}

async function sendUSSDReply() {
    if (!currentInputMode) {
        hideDialog();
        activeSessionId = null;
        textState = '';
        return;
    }

    const input = document.getElementById('ussd-input');
    const inputValue = input ? input.value.trim() : '';
    if (inputValue === '') return;

    // Append to text path sequence
    if (textState === '') {
        textState = inputValue;
    } else {
        textState += '*' + inputValue;
    }

    showDialog('Processing...');
    await makeUSSDRequest();
}

function handleInputKey(event) {
    if (event.key === 'Enter') {
        sendUSSDReply();
    }
}

async function makeUSSDRequest() {
    const payload = {
        sessionId: activeSessionId,
        serviceCode: serviceCode,
        phoneNumber: phoneNumber,
        text: textState
    };

    logMessage('request', 'POST /api/ussd/session', payload);

    try {
        const response = await fetch('/api/ussd/session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const bodyText = await response.text();
        logMessage('response', `Status: ${response.status}\nBody:\n${bodyText}`);

        if (response.status >= 200 && response.status < 300) {
            if (bodyText.startsWith('CON ')) {
                const cleanMsg = bodyText.substring(4);
                showDialog(cleanMsg, true);
            } else if (bodyText.startsWith('END ')) {
                const cleanMsg = bodyText.substring(4);
                showDialog(cleanMsg, false);
            } else {
                showDialog(bodyText, false);
            }
        } else {
            showDialog('Gateway Error. Please verify connection and backend server logs.', false);
        }
    } catch (e) {
        logMessage('error', `Fetch Error: ${e.message}`);
        showDialog('Connection error to backend server. Make sure the backend server is running.', false);
    }
}

// Bind all UI event listeners programmatically on page load
window.addEventListener('DOMContentLoaded', () => {
    // 1. Initial time display
    updatePhoneTime();

    // 2. Bind dial buttons
    const dialButtons = document.querySelectorAll('.dial-btn');
    dialButtons.forEach(button => {
        button.addEventListener('click', () => {
            const key = button.getAttribute('data-key');
            if (key) {
                pressKey(key);
            }
        });
    });

    // 3. Call button
    const callButton = document.getElementById('call-btn');
    if (callButton) {
        callButton.addEventListener('click', initiateUSSDCall);
    }

    // 4. Backspace button
    const backspaceButton = document.getElementById('backspace-btn');
    if (backspaceButton) {
        backspaceButton.addEventListener('click', deleteDigit);
    }

    // 5. USSD Dialog - Cancel button
    const cancelButton = document.getElementById('cancel-btn');
    if (cancelButton) {
        cancelButton.addEventListener('click', cancelSession);
    }

    // 6. USSD Dialog - Send button
    const sendButton = document.getElementById('send-btn');
    if (sendButton) {
        sendButton.addEventListener('click', sendUSSDReply);
    }

    // 7. USSD Dialog - Input text (Enter key handler)
    const ussdInput = document.getElementById('ussd-input');
    if (ussdInput) {
        ussdInput.addEventListener('keydown', handleInputKey);
    }

    // 8. Debugger panel - Clear logs button
    const clearLogsButton = document.getElementById('clear-logs-btn');
    if (clearLogsButton) {
        clearLogsButton.addEventListener('click', clearLogs);
    }
});
