// Deployment flow:
// 1) In production, set window.COLLEGEFINDR_API_BASE_URL in index.html.
// 2) In local dev, default to http://localhost:5000.
const runtimeApiBaseUrl = String(window.COLLEGEFINDR_API_BASE_URL || "")
    .trim()
    .replace(/\.$/, "")
    .replace(/\/+$/, "");
const runtimeClientKey = String(window.COLLEGEFINDR_CLIENT_KEY || "").trim();
const isFileProtocol = window.location.protocol === "file:";
const isLocalDev = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const defaultApiBaseUrl = (isLocalDev || isFileProtocol) ? "http://127.0.0.1:5000" : "";
const apiBaseUrl = runtimeApiBaseUrl || defaultApiBaseUrl;

const API = {
    ping: `${apiBaseUrl}/ping`,
    health: `${apiBaseUrl}/health`,
    chat: `${apiBaseUrl}/chat`,
    login: `${apiBaseUrl}/auth/login`,
    register: `${apiBaseUrl}/auth/register`,
    me: `${apiBaseUrl}/auth/me`,
    messages: `${apiBaseUrl}/messages`,
    contact: `${apiBaseUrl}/contact`,
    settings: `${apiBaseUrl}/settings`,
    applications: `${apiBaseUrl}/applications`,
};

const PROTECTED_PAGES = new Set([
    "chat-page",
    "saved-colleges-page",
    "applications-page",
    "financial-aid-page",
    "settings-page",
]);

const MESSAGE_STORAGE_KEYS = {
    "chat-messages": "collegefindr_chat_messages",
    "saved-chat-messages": "collegefindr_saved_messages",
    "applications-chat-messages": "collegefindr_applications_messages",
    "financial-aid-chat-messages": "collegefindr_financial_aid_messages",
    "settings-chat-messages": "collegefindr_settings_messages",
};

const PAGE_MESSAGE_CONTAINER = {
    "chat-page": "chat-messages",
    "saved-colleges-page": "saved-chat-messages",
    "applications-page": "applications-chat-messages",
    "financial-aid-page": "financial-aid-chat-messages",
    "settings-page": "settings-chat-messages",
};

const CHAT_STATUS_TEXT = {
    ready: "Ready",
    thinking: "Thinking...",
    waking: "Waking up server...",
    error: "Retry",
};

let authToken = localStorage.getItem("collegefindr_auth_token") || "";
let lastBackendWarmupAt = 0;
let authRequestInFlight = false;
let currentUser = null;
try {
    currentUser = JSON.parse(localStorage.getItem("collegefindr_user") || "null");
} catch (error) {
    currentUser = null;
}

if (!authToken) {
    currentUser = null;
}

let navigationHistory = [];
const MAX_HISTORY_DEPTH = 8;
try {
    const parsedHistory = JSON.parse(localStorage.getItem("collegefindr_page_history") || "[]");
    if (Array.isArray(parsedHistory)) {
        navigationHistory = parsedHistory.filter((value) => typeof value === "string");
    }
} catch (error) {
    navigationHistory = [];
}

function pushPageHistory(pageId) {
    if (!pageId || pageId === navigationHistory[navigationHistory.length - 1]) return;
    navigationHistory.push(pageId);
    if (navigationHistory.length > MAX_HISTORY_DEPTH) {
        navigationHistory.shift();
    }
    localStorage.setItem("collegefindr_page_history", JSON.stringify(navigationHistory));
}

function goBack() {
    if (navigationHistory.length > 1) {
        navigationHistory.pop();
        const previousPage = navigationHistory[navigationHistory.length - 1] || "landing-page";
        showPage(previousPage, { skipHistory: true });
    } else {
        showPage("landing-page");
    }
    localStorage.setItem("collegefindr_page_history", JSON.stringify(navigationHistory));
}

window.goBack = goBack;

function setAuthState(token, user) {
    authToken = token || "";
    currentUser = user || null;

    if (authToken) {
        localStorage.setItem("collegefindr_auth_token", authToken);
    } else {
        localStorage.removeItem("collegefindr_auth_token");
    }

    if (currentUser) {
        localStorage.setItem("collegefindr_user", JSON.stringify(currentUser));
    } else {
        localStorage.removeItem("collegefindr_user");
    }

    // Clear old user data when switching users (prevents showing old data from previous login)
    if (user) {
        Object.keys(MESSAGE_STORAGE_KEYS).forEach((key) => {
            localStorage.removeItem(MESSAGE_STORAGE_KEYS[key]);
        });
        navigationHistory = [];
        localStorage.removeItem("collegefindr_page_history");
    }

    renderCurrentUser();
}

function logout() {
    setAuthState("", null);
    showSuccessNotification("Logged out successfully");
    showPage("landing-page");
}

window.logout = logout;

function getAuthHeaders() {
    if (!authToken) return {};
    return { Authorization: `Bearer ${authToken}` };
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getExponentialBackoffDelay(baseDelayMs, attempt) {
    return baseDelayMs * Math.pow(2, attempt);
}

async function warmUpBackend(force = false, options = {}) {
    if (!apiBaseUrl) return;

    const now = Date.now();
    const warmupTtlMs = 2 * 60 * 1000;
    if (!force && now - lastBackendWarmupAt < warmupTtlMs) return;

    try {
        await apiJson(API.ping || API.health, {
            timeoutMs: 10000,
            retries: 3,
            retryDelayMs: 800,
            retryOnStatuses: [502, 503, 504, 522, 524],
            onWake: options.onWake,
            onWakeResolved: options.onWakeResolved,
        });
        lastBackendWarmupAt = Date.now();
    } catch (error) {
        // Ignore warm-up failures; the real auth call handles surfaced errors.
    }
}

async function apiJson(url, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? 10000);
    const retries = Number(options.retries ?? 3);
    const retryDelayMs = Number(options.retryDelayMs ?? 800);
    const retryOnStatuses = Array.isArray(options.retryOnStatuses)
        ? options.retryOnStatuses
        : [502, 503, 504, 522, 524];
    const wakeThresholdMs = Number(options.wakeThresholdMs ?? 3000);
    const showWakeMessage = options.showWakeMessage !== false;
    const onWake = typeof options.onWake === "function" ? options.onWake : null;
    const onWakeResolved = typeof options.onWakeResolved === "function" ? options.onWakeResolved : null;

    let wakeIndicatorShown = false;

    function resolveWakeState() {
        if (wakeIndicatorShown && onWakeResolved) {
            onWakeResolved();
        }
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        let wakeTimerId = null;

        if (showWakeMessage && !wakeIndicatorShown) {
            wakeTimerId = setTimeout(() => {
                wakeIndicatorShown = true;
                showInfoNotification("Waking up server...");
                if (onWake) onWake();
            }, wakeThresholdMs);
        }

        try {
            const headers = {
                Accept: "application/json",
                "X-Requested-With": "CollegeFindrWeb",
                ...(options.auth ? getAuthHeaders() : {}),
                ...(options.headers || {}),
            };

            if (options.body !== undefined) {
                headers["Content-Type"] = "application/json";
            }

            const response = await fetch(url, {
                method: options.method || "GET",
                headers,
                body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
                signal: controller.signal,
            });

            const data = await response.json().catch(() => ({}));
            const isLastAttempt = attempt >= retries;

            if (!response.ok) {
                if (!isLastAttempt && retryOnStatuses.includes(response.status)) {
                    await wait(getExponentialBackoffDelay(retryDelayMs, attempt));
                    continue;
                }

                if (isLastAttempt) {
                    resolveWakeState();
                }

                const error = new Error(data.error || `Request failed with status ${response.status}`);
                error.status = response.status;
                error.details = data.details || null;
                throw error;
            }

            resolveWakeState();

            return data;
        } catch (error) {
            const isLastAttempt = attempt >= retries;

            if (error?.name === "AbortError") {
                if (!isLastAttempt) {
                    await wait(getExponentialBackoffDelay(retryDelayMs, attempt));
                    continue;
                }

                resolveWakeState();

                const timeoutError = new Error(
                    "Request timed out while contacting the backend. " +
                    "If using Render, wait a few seconds and try again (cold start)."
                );
                timeoutError.status = 408;
                throw timeoutError;
            }

            if (error?.name === "TypeError") {
                if (!isLastAttempt) {
                    await wait(getExponentialBackoffDelay(retryDelayMs, attempt));
                    continue;
                }

                resolveWakeState();

                const apiTarget = apiBaseUrl || window.location.origin;
                const originInfo = isFileProtocol ? "file:// (origin: null)" : window.location.origin;
                const networkError = new Error(
                    `Network/CORS error. Could not reach API at ${apiTarget} from origin ${originInfo}. ` +
                    "Allowed origin is: https://mouleesh-user.github.io"
                );
                networkError.status = 0;
                throw networkError;
            }

            if (isLastAttempt) {
                resolveWakeState();
            }

            throw error;
        } finally {
            clearTimeout(timeoutId);
            if (wakeTimerId) {
                clearTimeout(wakeTimerId);
            }
        }
    }
}

function showErrorNotification(message) {
    const notification = document.createElement("div");
    notification.style.cssText = [
        "position: fixed",
        "top: 20px",
        "right: 20px",
        "background-color: #f72585",
        "color: white",
        "padding: 12px 16px",
        "border-radius: 6px",
        "z-index: 2000",
        "max-width: 340px",
        "box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1)",
    ].join(";");
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => {
        notification.style.opacity = "0";
        notification.style.transition = "opacity 0.3s";
        setTimeout(() => notification.remove(), 300);
    }, 4000);
}

function showSuccessNotification(message) {
    const notification = document.createElement("div");
    notification.style.cssText = [
        "position: fixed",
        "top: 20px",
        "right: 20px",
        "background-color: #4cc9f0",
        "color: white",
        "padding: 12px 16px",
        "border-radius: 6px",
        "z-index: 2000",
        "max-width: 340px",
        "box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1)",
    ].join(";");
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => {
        notification.style.opacity = "0";
        notification.style.transition = "opacity 0.3s";
        setTimeout(() => notification.remove(), 300);
    }, 2500);
}

function showInfoNotification(message) {
    const notification = document.createElement("div");
    notification.style.cssText = [
        "position: fixed",
        "top: 20px",
        "right: 20px",
        "background-color: #4361ee",
        "color: white",
        "padding: 12px 16px",
        "border-radius: 6px",
        "z-index: 2000",
        "max-width: 340px",
        "box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1)",
    ].join(";");
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => {
        notification.style.opacity = "0";
        notification.style.transition = "opacity 0.3s";
        setTimeout(() => notification.remove(), 300);
    }, 2800);
}

function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).toLowerCase());
}

async function getCaptchaToken(action) {
    if (typeof window.getCollegeFindrCaptchaToken !== "function") {
        return "";
    }

    try {
        const token = await window.getCollegeFindrCaptchaToken(action);
        return String(token || "").trim();
    } catch (error) {
        console.warn("Captcha provider failed", error);
        return "";
    }
}

function escapeHtml(text) {
    return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function configureMarkdownRenderer() {
    if (!window.marked || typeof window.marked.setOptions !== "function") return;

    window.marked.setOptions({
        gfm: true,
        breaks: true,
    });
}

function sanitizeRenderedHtml(html) {
    if (window.DOMPurify && typeof window.DOMPurify.sanitize === "function") {
        return window.DOMPurify.sanitize(html, {
            USE_PROFILES: { html: true },
        });
    }

    return escapeHtml(html).replace(/\n/g, "<br>");
}

function formatMessageContent(text, sender) {
    const normalizedText = String(text ?? "");

    if (sender === "bot" && window.marked && typeof window.marked.parse === "function") {
        const renderedHtml = window.marked.parse(normalizedText);
        return sanitizeRenderedHtml(renderedHtml);
    }

    const safeText = escapeHtml(normalizedText);
    return safeText.replace(/\n/g, "<br>");
}

function formatDisplayTime(isoTime) {
    if (!isoTime) {
        return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    const date = new Date(isoTime);
    if (Number.isNaN(date.getTime())) {
        return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function saveMessagesToStorage(containerId) {
    try {
        const container = document.getElementById(containerId);
        const storageKey = MESSAGE_STORAGE_KEYS[containerId];
        if (!container || !storageKey) return;

        const messages = Array.from(container.querySelectorAll(".message")).map((msg) => ({
            sender: msg.classList.contains("bot-message") ? "bot" : "user",
            text: msg.querySelector(".message-bubble")?.textContent || "",
            time: msg.querySelector(".message-time")?.textContent || "",
        }));

        localStorage.setItem(storageKey, JSON.stringify(messages));
    } catch (error) {
        console.warn("Failed to save messages", error);
    }
}

function addMessage(messagesContainer, sender, text, options = {}) {
    if (!messagesContainer) return;

    const messageEl = document.createElement("div");
    messageEl.className = `message ${sender === "bot" ? "bot-message" : "user-message"}`;

    const avatarEl = document.createElement("div");
    avatarEl.className = `message-avatar ${sender === "bot" ? "bot-avatar" : "user-avatar"}`;
    avatarEl.textContent = sender === "bot" ? "AI" : "U";

    const contentEl = document.createElement("div");
    contentEl.className = "message-content";

    const bubbleEl = document.createElement("div");
    bubbleEl.className = "message-bubble";
    bubbleEl.innerHTML = formatMessageContent(text, sender);

    const timeEl = document.createElement("div");
    timeEl.className = "message-time";
    timeEl.textContent = formatDisplayTime(options.timestamp || null);

    contentEl.appendChild(bubbleEl);
    contentEl.appendChild(timeEl);
    messageEl.appendChild(avatarEl);
    messageEl.appendChild(contentEl);

    messagesContainer.appendChild(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    if (options.persist !== false && messagesContainer.id) {
        saveMessagesToStorage(messagesContainer.id);
    }
}

function getDefaultChatWelcomeMessage() {
    return (
        "Hi there! I'm your College Search Assistant. I can help you find colleges " +
        "that match your preferences. Tell me about your academic interests, " +
        "preferred locations, budget, and any other factors that are important to you!"
    );
}

function updateChatStatus(mode) {
    const statusEl = document.getElementById("chat-status");
    if (!statusEl) return;

    const safeMode = ["ready", "thinking", "waking", "error"].includes(mode) ? mode : "ready";
    statusEl.textContent = CHAT_STATUS_TEXT[safeMode] || CHAT_STATUS_TEXT.ready;
    statusEl.className = `chat-status chat-status-${safeMode}`;
}

function bindChatPageControls() {
    const clearBtn = document.getElementById("clear-chat-btn");
    const scrollBtn = document.getElementById("scroll-chat-btn");
    const suggestionsContainer = document.getElementById("chat-suggestions");
    const mainInput = document.getElementById("message-input");
    const mainMessages = document.getElementById("chat-messages");

    if (clearBtn && mainMessages && clearBtn.dataset.bound !== "1") {
        clearBtn.dataset.bound = "1";
        clearBtn.addEventListener("click", () => {
            const shouldClear = window.confirm("Clear the current chat view?");
            if (!shouldClear) return;

            mainMessages.innerHTML = "";
            addMessage(mainMessages, "bot", getDefaultChatWelcomeMessage(), { persist: false });
            saveMessagesToStorage("chat-messages");
            updateChatStatus("ready");
        });
    }

    if (scrollBtn && mainMessages && scrollBtn.dataset.bound !== "1") {
        scrollBtn.dataset.bound = "1";
        scrollBtn.addEventListener("click", () => {
            mainMessages.scrollTop = mainMessages.scrollHeight;
        });
    }

    if (suggestionsContainer && mainInput) {
        suggestionsContainer.querySelectorAll(".suggestion-chip").forEach((chip) => {
            if (chip.dataset.bound === "1") return;
            chip.dataset.bound = "1";
            chip.addEventListener("click", () => {
                const suggestion = chip.getAttribute("data-suggestion") || "";
                if (!suggestion) return;

                mainInput.value = suggestion;
                mainInput.dispatchEvent(new Event("input", { bubbles: true }));
                mainInput.focus();
            });
        });
    }
}

function addTypingIndicator(messagesContainer) {
    if (!messagesContainer) return null;

    const indicator = document.createElement("div");
    indicator.className = "message bot-message typing-indicator";
    indicator.innerHTML = `
        <div class="message-avatar bot-avatar">AI</div>
        <div class="message-content">
            <div class="message-bubble">
                <div class="typing-dots"><span>.</span><span>.</span><span>.</span></div>
            </div>
        </div>
    `;

    messagesContainer.appendChild(indicator);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return indicator;
}

function loadMessagesFromStorage(containerId) {
    try {
        const storageKey = MESSAGE_STORAGE_KEYS[containerId];
        if (!storageKey) return;

        const raw = localStorage.getItem(storageKey);
        if (!raw) return;

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) return;

        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = "";
        parsed.forEach((msg) => addMessage(container, msg.sender === "bot" ? "bot" : "user", msg.text, { persist: false }));
    } catch (error) {
        console.warn("Failed to load messages", error);
    }
}

async function syncMessagesFromServer(containerId) {
    if (!authToken) return;

    const container = document.getElementById(containerId);
    if (!container) return;

    try {
        const data = await apiJson(`${API.messages}/${encodeURIComponent(containerId)}`, { auth: true });
        const messages = Array.isArray(data.messages) ? data.messages : [];
        if (messages.length === 0) return;

        container.innerHTML = "";
        for (const message of messages) {
            addMessage(
                container,
                message.role === "assistant" ? "bot" : "user",
                message.content,
                { timestamp: message.created_at, persist: false }
            );
        }

        saveMessagesToStorage(containerId);
    } catch (error) {
        if (error.status === 401) {
            logout();
            showErrorNotification("Session expired. Please log in again.");
        }
    }
}

async function syncAllChatContainers() {
    const ids = Object.keys(MESSAGE_STORAGE_KEYS);
    for (const id of ids) {
        await syncMessagesFromServer(id);
    }
}

async function fetchChatReply(userMessage, context, options = {}) {
    await warmUpBackend(false, {
        onWake: options.onWake,
        onWakeResolved: options.onWakeResolved,
    });

    const data = await apiJson(API.chat, {
        method: "POST",
        auth: Boolean(authToken),
        timeoutMs: 10000,
        retries: 3,
        retryDelayMs: 800,
        retryOnStatuses: [502, 503, 504, 522, 524],
        headers: runtimeClientKey ? { "X-CLIENT-KEY": runtimeClientKey } : {},
        onWake: options.onWake,
        onWakeResolved: options.onWakeResolved,
        body: {
            message: userMessage,
            context,
        },
    });

    if (!data.reply) {
        throw new Error("Invalid backend response: missing reply");
    }

    return data.reply;
}

async function handleChatSubmit(formId, inputId, messagesId) {
    const form = document.getElementById(formId);
    const input = document.getElementById(inputId);
    const messagesContainer = document.getElementById(messagesId);

    if (!form || !input || !messagesContainer) return;
    if (form.dataset.chatSubmitBound === "1") return;
    form.dataset.chatSubmitBound = "1";

    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        if (form.dataset.submitting === "1") {
            return;
        }

        if (!authToken) {
            showErrorNotification("Please log in to continue chatting.");
            showPage("login-page");
            return;
        }

        const userMessage = input.value.trim();
        if (!userMessage) {
            showErrorNotification("Please type a message");
            if (messagesId === "chat-messages") updateChatStatus("ready");
            return;
        }

        if (userMessage.length > 5000) {
            showErrorNotification("Message too long (max 5000 characters)");
            if (messagesId === "chat-messages") updateChatStatus("error");
            return;
        }

        addMessage(messagesContainer, "user", userMessage);
        input.value = "";
        input.style.height = "";

        const submitBtn = form.querySelector('button[type="submit"]');
        const originalText = submitBtn?.textContent || "Send";
        form.dataset.submitting = "1";
        input.disabled = true;
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = "Sending...";
        }

        const typingIndicator = addTypingIndicator(messagesContainer);
        if (messagesId === "chat-messages") updateChatStatus("thinking");

        try {
            const reply = await fetchChatReply(userMessage, messagesId, {
                onWake: () => {
                    if (messagesId === "chat-messages") updateChatStatus("waking");
                },
                onWakeResolved: () => {
                    if (messagesId === "chat-messages") updateChatStatus("thinking");
                },
            });
            if (typingIndicator) typingIndicator.remove();
            addMessage(messagesContainer, "bot", reply);
            if (messagesId === "chat-messages") updateChatStatus("ready");
        } catch (error) {
            if (typingIndicator) typingIndicator.remove();

            if (error.status === 401) {
                addMessage(messagesContainer, "bot", "Your session expired. Please log in again to continue chatting.");
                showErrorNotification("Session expired. Please log in again.");
                if (messagesId === "chat-messages") updateChatStatus("error");
                logout();
                return;
            }

            const message = error.message.includes("Failed to fetch")
                ? "Network error. Please check your connection."
                : error.message || "Sorry, I could not process that request right now.";

            addMessage(messagesContainer, "bot", message);
            showErrorNotification(message);
            if (messagesId === "chat-messages") updateChatStatus("error");
        } finally {
            form.dataset.submitting = "0";
            input.disabled = false;
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        }
    });
}

window.showPage = function showPage(pageId, options = {}) {
    if (PROTECTED_PAGES.has(pageId) && !authToken) {
        showErrorNotification("Please log in first.");
        pageId = "login-page";
    }

    document.querySelectorAll(".page").forEach((page) => {
        page.style.display = "none";
    });

    const target = document.getElementById(pageId);
    if (!target) return;

    target.style.display = "block";
    const isChatShellPage = PROTECTED_PAGES.has(pageId);
    document.body.classList.toggle("chat-shell-active", isChatShellPage);
    document.documentElement.classList.toggle("chat-shell-active", isChatShellPage);
    initializeMobileSidebar();
    updateActiveSidebarLink(pageId);

    if (!options.skipHistory) {
        pushPageHistory(pageId);
    }

    if (PROTECTED_PAGES.has(pageId)) {
        renderCurrentUser();
    }

    const messageContainerId = PAGE_MESSAGE_CONTAINER[pageId];
    if (messageContainerId) {
        loadMessagesFromStorage(messageContainerId);
    }

    if (pageId === "settings-page") {
        loadSettingsIntoForm();
    }

    if (pageId === "applications-page") {
        loadApplications();
    }
};

window.smoothScrollToSection = function smoothScrollToSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (section) {
        section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
};

function preventPlaceholderLinkJumps() {
    document.querySelectorAll('a[href="#"]').forEach((anchor) => {
        anchor.addEventListener("click", (event) => {
            event.preventDefault();
        });
    });
}

function updateActiveSidebarLink(pageId) {
    document.querySelectorAll(".menu-link").forEach((link) => {
        const onClickCode = link.getAttribute("onclick") || "";
        const isActive = onClickCode.includes(`showPage('${pageId}')`);
        link.classList.toggle("active", isActive);
    });
}

window.toggleMobileSidebar = function toggleMobileSidebar() {
    const visiblePage = Array.from(document.querySelectorAll(".page")).find(
        (page) => window.getComputedStyle(page).display !== "none"
    );

    const sidebar = visiblePage?.querySelector(".chat-sidebar") || null;
    const overlay = visiblePage?.querySelector(".chat-sidebar-overlay") || null;
    const menuToggle = visiblePage?.querySelector(".mobile-menu-toggle") || null;

    if (sidebar) sidebar.classList.toggle("open");
    if (overlay) overlay.classList.toggle("active");
    if (menuToggle) menuToggle.classList.toggle("active");
};

function initializeMobileSidebar() {
    const sidebars = document.querySelectorAll(".chat-sidebar");
    const overlays = document.querySelectorAll(".chat-sidebar-overlay");
    const menuToggles = document.querySelectorAll(".mobile-menu-toggle");
    const screenWidth = window.innerWidth;

    if (sidebars.length === 0) return;

    if (screenWidth <= 768) {
        sidebars.forEach((sidebar) => {
            sidebar.classList.add("mobile-hidden");
        });
    } else {
        sidebars.forEach((sidebar) => {
            sidebar.classList.remove("mobile-hidden");
            sidebar.classList.remove("open");
        });
        overlays.forEach((overlay) => overlay.classList.remove("active"));
        menuToggles.forEach((menuToggle) => menuToggle.classList.remove("active"));
    }
}

window.addEventListener("resize", () => {
    initializeMobileSidebar();
});

function renderCurrentUser() {
    const name = currentUser?.full_name || "User";
    const initial = name.trim().charAt(0).toUpperCase() || "U";

    document.querySelectorAll(".user-name").forEach((el) => {
        el.textContent = name;
    });

    document.querySelectorAll(".user-avatar").forEach((el) => {
        if (el.closest(".message")) return;
        el.textContent = initial;
    });
}

async function bootstrapAuthSession() {
    if (!authToken) return;

    try {
        const profile = await apiJson(API.me, { auth: true });
        setAuthState(authToken, profile.user);
    } catch (error) {
        if (error.status === 401) {
            setAuthState("", null);
            return;
        }

        console.warn("Failed to restore auth profile", error);
    }

    try {
        await syncAllChatContainers();
    } catch (error) {
        console.warn("Failed to sync chat history during bootstrap", error);
    }
}

function attachLogoutHandlers() {
    document.querySelectorAll(".menu-link").forEach((link) => {
        if (link.textContent.toLowerCase().includes("logout")) {
            link.setAttribute("onclick", "logout(); toggleMobileSidebar(); return false;");
        }
    });
}

function attachTextareaBehavior() {
    document.querySelectorAll(".input-field").forEach((textarea) => {
        if (textarea.dataset.behaviorBound === "1") return;
        textarea.dataset.behaviorBound = "1";

        textarea.addEventListener("input", function resize() {
            this.style.height = "auto";
            this.style.height = `${this.scrollHeight}px`;
            if (this.value === "") this.style.height = "";
        });

        textarea.addEventListener("keydown", function onEnter(event) {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const parentForm = this.closest("form");
                if (parentForm) parentForm.requestSubmit();
            }
        });
    });
}

function bindAuthForms() {
    const loginForm = document.getElementById("login-form");
    const registerBtn = document.getElementById("register-btn");

    function setAuthButtonsLoading(loading, loginLabel, registerLabel) {
        const loginSubmitBtn = loginForm?.querySelector('button[type="submit"]') || null;
        if (loginSubmitBtn) {
            loginSubmitBtn.disabled = loading;
            loginSubmitBtn.textContent = loading ? loginLabel : "Login";
        }

        if (registerBtn) {
            registerBtn.disabled = loading;
            registerBtn.textContent = loading ? registerLabel : "Create Account";
        }
    }

    if (loginForm && loginForm.dataset.authBound !== "1") {
        loginForm.dataset.authBound = "1";
        loginForm.addEventListener("submit", async (event) => {
            event.preventDefault();

            if (authRequestInFlight) return;

            const email = document.getElementById("email")?.value.trim() || "";
            const password = document.getElementById("password")?.value || "";

            if (!validateEmail(email)) {
                showErrorNotification("Please enter a valid email.");
                return;
            }
            if (password.length < 8) {
                showErrorNotification("Password must be at least 8 characters.");
                return;
            }

            try {
                authRequestInFlight = true;
                setAuthButtonsLoading(true, "Logging in...", "Please wait...");
                await warmUpBackend(true);

                const captchaToken = await getCaptchaToken("login");
                const loginBody = { email, password };
                if (captchaToken) {
                    loginBody.captcha_token = captchaToken;
                }

                const data = await apiJson(API.login, {
                    method: "POST",
                    timeoutMs: 10000,
                    retries: 3,
                    retryDelayMs: 800,
                    retryOnStatuses: [502, 503, 504, 522, 524],
                    body: loginBody,
                });

                if (!data?.token || !data?.user) {
                    throw new Error("Invalid login response from server");
                }

                setAuthState(data.token, data.user);
                showSuccessNotification("Login successful");
                showPage("chat-page");
                syncAllChatContainers().catch((syncError) => {
                    console.warn("Chat sync failed after login", syncError);
                });
            } catch (error) {
                showErrorNotification(error.message || "Login failed");
            } finally {
                authRequestInFlight = false;
                setAuthButtonsLoading(false, "", "");
            }
        });
    }

    if (registerBtn && registerBtn.dataset.authBound !== "1") {
        registerBtn.dataset.authBound = "1";
        registerBtn.addEventListener("click", async () => {
            if (authRequestInFlight) return;

            const fullName = document.getElementById("auth-full-name")?.value.trim() || "";
            const email = document.getElementById("email")?.value.trim() || "";
            const password = document.getElementById("password")?.value || "";

            if (fullName.length < 2) {
                showErrorNotification("Please enter your full name to create an account.");
                return;
            }
            if (!validateEmail(email)) {
                showErrorNotification("Please enter a valid email.");
                return;
            }
            if (password.length < 8) {
                showErrorNotification("Password must be at least 8 characters.");
                return;
            }

            try {
                authRequestInFlight = true;
                setAuthButtonsLoading(true, "Please wait...", "Creating...");
                await warmUpBackend(true);

                const captchaToken = await getCaptchaToken("register");
                const registerBody = {
                    full_name: fullName,
                    email,
                    password,
                };
                if (captchaToken) {
                    registerBody.captcha_token = captchaToken;
                }

                const data = await apiJson(API.register, {
                    method: "POST",
                    timeoutMs: 10000,
                    retries: 3,
                    retryDelayMs: 800,
                    retryOnStatuses: [502, 503, 504, 522, 524],
                    body: registerBody,
                });

                if (!data?.token || !data?.user) {
                    throw new Error("Invalid signup response from server");
                }

                setAuthState(data.token, data.user);
                showSuccessNotification("Account created successfully");
                showPage("chat-page");
                syncAllChatContainers().catch((syncError) => {
                    console.warn("Chat sync failed after signup", syncError);
                });
            } catch (error) {
                showErrorNotification(error.message || "Failed to create account");
            } finally {
                authRequestInFlight = false;
                setAuthButtonsLoading(false, "", "");
            }
        });
    }

}

function bindContactForm() {
    const contactForm = document.getElementById("contact-form");
    if (!contactForm) return;
    if (contactForm.dataset.bound === "1") return;
    contactForm.dataset.bound = "1";

    contactForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        const name = document.getElementById("name")?.value.trim() || "";
        const email = document.getElementById("contact-email")?.value.trim() || "";
        const message = document.getElementById("message")?.value.trim() || "";

        if (name.length < 2) return showErrorNotification("Please enter your name.");
        if (!validateEmail(email)) return showErrorNotification("Please enter a valid email.");
        if (message.length < 2) return showErrorNotification("Please enter a message.");

        const submitBtn = contactForm.querySelector('button[type="submit"]');
        const originalText = submitBtn?.textContent || "Send Message";
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = "Sending...";
        }

        try {
            const captchaToken = await getCaptchaToken("contact");
            const contactBody = { name, email, message };
            if (captchaToken) {
                contactBody.captcha_token = captchaToken;
            }

            await apiJson(API.contact, {
                method: "POST",
                body: contactBody,
                auth: Boolean(authToken),
            });

            contactForm.reset();
            showSuccessNotification("Message sent successfully");
        } catch (error) {
            showErrorNotification(error.message || "Failed to send message");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        }
    });
}

async function loadSettingsIntoForm() {
    if (!authToken) return;

    try {
        const data = await apiJson(API.settings, { auth: true });
        const user = data.user || {};
        const settings = data.settings || {};

        const fullNameInput = document.getElementById("settings-full-name");
        const emailInput = document.getElementById("settings-email");
        const phoneInput = document.getElementById("settings-phone");

        if (fullNameInput) fullNameInput.value = user.full_name || "";
        if (emailInput) emailInput.value = user.email || "";
        if (phoneInput) phoneInput.value = user.phone || "";

        const notifyDeadlines = document.getElementById("notify-deadlines");
        const notifyWeekly = document.getElementById("notify-weekly");
        const notifyMarketing = document.getElementById("notify-marketing");
        const notifyScholarships = document.getElementById("notify-scholarships");

        if (notifyDeadlines) notifyDeadlines.checked = Boolean(settings.notify_deadlines);
        if (notifyWeekly) notifyWeekly.checked = Boolean(settings.notify_weekly_recommendations);
        if (notifyMarketing) notifyMarketing.checked = Boolean(settings.notify_marketing);
        if (notifyScholarships) notifyScholarships.checked = Boolean(settings.notify_scholarships);
    } catch (error) {
        if (error.status === 401) {
            showErrorNotification("Session expired. Please log in again.");
            logout();
            return;
        }
        showErrorNotification(error.message || "Failed to load settings");
    }
}

function bindSettingsForms() {
    const profileForm = document.getElementById("profile-form");
    const preferenceForm = document.getElementById("preferences-form");

    async function submitSettings() {
        if (!authToken) {
            showErrorNotification("Please log in first.");
            showPage("login-page");
            return;
        }

        const fullName = document.getElementById("settings-full-name")?.value.trim() || "";
        const phone = document.getElementById("settings-phone")?.value.trim() || "";

        const notifyDeadlines = document.getElementById("notify-deadlines")?.checked ?? true;
        const notifyWeekly = document.getElementById("notify-weekly")?.checked ?? true;
        const notifyMarketing = document.getElementById("notify-marketing")?.checked ?? false;
        const notifyScholarships = document.getElementById("notify-scholarships")?.checked ?? true;

        if (fullName.length < 2) {
            showErrorNotification("Full name must be at least 2 characters.");
            return;
        }

        const payload = {
            full_name: fullName,
            phone,
            notify_deadlines: notifyDeadlines,
            notify_weekly_recommendations: notifyWeekly,
            notify_marketing: notifyMarketing,
            notify_scholarships: notifyScholarships,
        };

        await apiJson(API.settings, {
            method: "PUT",
            auth: true,
            body: payload,
        });

        if (currentUser) {
            currentUser.full_name = fullName;
            currentUser.phone = phone;
            setAuthState(authToken, currentUser);
        }

        showSuccessNotification("Settings updated");
    }

    if (profileForm && profileForm.dataset.bound !== "1") {
        profileForm.dataset.bound = "1";
        profileForm.addEventListener("submit", async (event) => {
            event.preventDefault();
            try {
                await submitSettings();
            } catch (error) {
                showErrorNotification(error.message || "Failed to update profile");
            }
        });
    }

    if (preferenceForm && preferenceForm.dataset.bound !== "1") {
        preferenceForm.dataset.bound = "1";
        preferenceForm.addEventListener("submit", async (event) => {
            event.preventDefault();
            try {
                await submitSettings();
            } catch (error) {
                showErrorNotification(error.message || "Failed to save preferences");
            }
        });
    }
}

function renderApplications(applications) {
    const target = document.getElementById("applications-list");
    if (!target) return;

    if (!Array.isArray(applications) || applications.length === 0) {
        target.innerHTML = '<p class="panel-empty-text">No applications yet. Add your first one above.</p>';
        return;
    }

    target.innerHTML = applications.map((item) => {
        const status = (item.status || "pending").toUpperCase();
        const deadline = item.deadline || "Not set";
        const createdAt = item.created_at ? new Date(item.created_at).toLocaleDateString() : "N/A";

        return `
            <div class="panel-card">
                <div class="app-card-top">
                    <div class="app-card-content">
                        <h3 class="panel-card-title panel-card-title-sm">${escapeHtml(item.college_name || "")}</h3>
                        <p class="panel-card-meta panel-card-meta-tight"><strong>Deadline:</strong> ${escapeHtml(deadline)}</p>
                        <p class="panel-card-meta panel-card-meta-tight"><strong>Created:</strong> ${escapeHtml(createdAt)}</p>
                        <p class="panel-card-meta panel-card-meta-tight"><strong>Notes:</strong> ${escapeHtml(item.notes || "-")}</p>
                    </div>
                    <span class="app-status-badge">${escapeHtml(status)}</span>
                </div>
            </div>
        `;
    }).join("");
}

async function loadApplications() {
    if (!authToken) return;
    try {
        const data = await apiJson(API.applications, { auth: true });
        renderApplications(data.applications || []);
    } catch (error) {
        if (error.status === 401) {
            showErrorNotification("Session expired. Please log in again.");
            logout();
            return;
        }
        showErrorNotification(error.message || "Failed to load applications");
    }
}

function bindApplicationForm() {
    const form = document.getElementById("application-form");
    if (!form) return;
    if (form.dataset.bound === "1") return;
    form.dataset.bound = "1";

    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        if (!authToken) {
            showErrorNotification("Please log in first.");
            showPage("login-page");
            return;
        }

        const collegeName = document.getElementById("application-college-name")?.value.trim() || "";
        const status = document.getElementById("application-status")?.value || "pending";
        const deadline = document.getElementById("application-deadline")?.value || "";
        const notes = document.getElementById("application-notes")?.value.trim() || "";

        if (collegeName.length < 2) {
            showErrorNotification("Please provide a valid college name.");
            return;
        }

        const submitBtn = form.querySelector('button[type="submit"]');
        const originalText = submitBtn?.textContent || "Add Application";
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = "Saving...";
        }

        try {
            await apiJson(API.applications, {
                method: "POST",
                auth: true,
                body: {
                    college_name: collegeName,
                    status,
                    deadline,
                    notes,
                },
            });

            form.reset();
            showSuccessNotification("Application added");
            await loadApplications();
        } catch (error) {
            showErrorNotification(error.message || "Failed to add application");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        }
    });
}

document.addEventListener("DOMContentLoaded", async () => {
    configureMarkdownRenderer();
    initializeMobileSidebar();
    preventPlaceholderLinkJumps();
    attachLogoutHandlers();
    attachTextareaBehavior();

    bindAuthForms();
    bindContactForm();
    bindSettingsForms();
    bindApplicationForm();
    bindChatPageControls();
    updateChatStatus("ready");

    await handleChatSubmit("message-form", "message-input", "chat-messages");
    await handleChatSubmit("saved-message-form", "saved-message-input", "saved-chat-messages");
    await handleChatSubmit("applications-message-form", "applications-message-input", "applications-chat-messages");
    await handleChatSubmit("financial-aid-message-form", "financial-aid-message-input", "financial-aid-chat-messages");
    await handleChatSubmit("settings-message-form", "settings-message-input", "settings-chat-messages");

    Object.keys(MESSAGE_STORAGE_KEYS).forEach((containerId) => loadMessagesFromStorage(containerId));

    await bootstrapAuthSession();

    if (authToken) {
        showPage("chat-page");
    } else {
        showPage("landing-page");
    }
});
