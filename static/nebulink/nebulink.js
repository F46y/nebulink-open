//WIDGETS
//https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/widgets

// HAND CONTROLS
//https://github.com/immersive-web/webxr-hand-input/blob/master/explainer.md

//AI
//https://blogs.windows.com/msedgedev/2025/05/19/introducing-the-prompt-and-writing-assistance-apis/
//https://learn.microsoft.com/en-us/microsoft-edge/web-platform/prompt-api

import {AIHelper, MastodonAccount} from "./classes.js";

const features = {
    device: "phone",
    memory: 2,
    storage: 128,
    vibrate: false,
    share: false,
    wearConnection: false,
    summarize: false,
    detector: false,
    language: false,
    wasm: false,
    localFiles: false,
    cache: false,
};
let currentMode = {
    type: "home", modifier: null,
};
let currentStatuses = [];
let offset = 0;
let commentsQueue = [];
let processingComments = false;
let currentStatus;
let currentTopic;
let currentAccount;
let currentTootId;
let ai;
let nsfwEnabled = false;
let aiEnabled = false;
const apiURLs = {
    home: "/api/v1/timelines/home",
    recommendation: "/api/v1/trends/statuses",
    hashtag: "/api/v1/timelines/tag/:{0}",
    trending: "/api/v1/trends/statuses",
    account: "/api/v1/accounts/{0}/statuses",
    search: "/api/v2/search?q={0}&type=statuses",
    search_hashtags: "/api/v2/search?q={0}&type=hashtags",
};
let nsfwWords = ["nsfw", "18+", "explicit", "lewd", "adult", "topless", "nude", "naked", "tits", "tiddies", "boobs", "sex", "booty", "ass", "porn"];
let max_id = null; //cursor for fetching timeline
let isLoadingMore = false;

let db = new Dexie("nebulinkDB");

async function versionCheck() {
    const browser = getBrowserInfo();
    localStorage.setItem("browserName", browser.name);
    localStorage.setItem("browserVersion", browser.version);

    if (browser.name === "Edge" && browser.version < 115) {
        alert("Your browser version is too low. Please update to the latest version of Edge.");
    }

    switch (browser.name) {
        case "Safari":
        case "Firefox":
            alert(`${browser.name} is not supported. Please use Chrome or Edge.`);
            break;
        case "Edge":
        case "Chrome":
        case "Samsung Internet":
        case "Opera":
        case "Unknown":
            if (browser.version < 138) {
                alert("Please update your browser to the latest version. AstroReader may not work properly.");
            }
            break;
    }

    await getFeatureAvailability(browser);
}

async function getDeviceType() {
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const devicePixelRatio = window.devicePixelRatio || 1;

    // Check for smartwatch (very small screens)
    if (screenWidth >= 1 && screenWidth <= 480 && devicePixelRatio >= 1.0 && screenHeight >= 1 && screenHeight <= 480) {
        return "watch";
    }

    // Check for phones
    if (screenWidth <= 480) {
        return "phone";
    }

    // Check for XR Headsets
    if ((await isXRHeadset()) === true) {
        return "xr";
    }

    // Check for tablets
    if (screenWidth >= 481 && screenWidth <= 1024) {
        return "tablet";
    }

    // Default to PC/large screens
    return "pc";
}

async function isXRHeadset() {
    if (navigator.xr) {
        const vr = await navigator.xr.isSessionSupported('immersive-vr');
        const ar = await navigator.xr.isSessionSupported('immersive-ar');
        return !!(vr && ar);
    } else {
        return false;
    }
}

async function getFeatureAvailability(browser) {
    if (browser.name !== "Safari" && browser.name !== "Firefox") {
        //FEATURE CHECK
        if (navigator.share) {
            features.share = true;
        }

        if (RTCPeerConnection && typeof RTCPeerConnection === "function") {
            features.wearConnection = true;
        }

        if (navigator.deviceMemory) {
            features.memory = navigator.deviceMemory;
        }

        if (navigator.vibrate) {
            features.vibrate = true;
        }

        if (typeof Summarizer !== "undefined" && Summarizer) {
            features.summarize = true;
        }

        if ("LanguageDetector" in self) {
            if ((await LanguageDetector.availability()) !== "unavailable") {
                features.detector = true;
            }
        }
        if ("Translator" in self) {
            features.translate = true;
        }

        if (typeof LanguageModel !== "undefined" && LanguageModel) {
            if ((await LanguageModel.availability()) !== "unavailable") {
                features.language = true;
            }
        } else {
            document.getElementById("ai-models").options[0].disabled = true;
            document.getElementById("ai-models").selectedIndex = 1;
        }

        if ("showOpenFilePicker" in window) {
            features.localFiles = true;
        }

        if (typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function") {
            features.wasm = true;
        } else {
            document.getElementById("ai-models").options[1].disabled = true;
            if (features.language === false) {
                document.getElementById("ai-models").remove();
                document.getElementById("get-ai").remove();
            }
        }

        if ("storage" in navigator && "estimate" in navigator.storage) {
            const {usage, quota} = await navigator.storage.estimate();
            const availableSpaceInBytes = quota - usage;
            const availableSpaceInMB = availableSpaceInBytes / (1024 * 1024);
            features.storage = availableSpaceInMB / 1024;

            if (features.storage < 1) {
                features.storage = 1;
            }
        }

        if ("caches" in window && typeof window.caches.open === "function") {
            features.cache = true;
        }

        //USE THE FEATURES
        if (features.summarize) {
            if ((await Summarizer.availability({outputLanguage: "en"})) === "available") {
                features.summarize = true;
            }
        }

        if (features.language) {
            switch (await LanguageModel.availability({
                expectedInputs: [{type: "text", languages: ["en"]}],
                expectedOutputs: [{type: "text", languages: ["en"]}],
            })) {
                case "available":
                    break;
                case "downloadable":
                    document.getElementById("get-ai").classList.remove("hidden");
                    break;
            }
        }

        if (features.device === "watch") {
            document.getElementById("get-ai").classList.add("hidden");
            document.getElementById("ai-models").remove();
            document.getElementById("ai-toggle").checked = false;
            document.getElementById("ai-toggle").remove();
            document.getElementById("ai-size").remove();
            document.getElementById("clear-cache").remove();
            await removeModels();
        } else if (features.device === "xr") {
            document.getElementById("renderCanvas").classList.remove("hidden");
            document.getElementById("enterVRButton").classList.remove("hidden");
            initXR()
        }
    }
}

function getBrowserInfo() {
    const ua = navigator.userAgent;
    if (/Edg\/([\d.]+)/.test(ua)) {
        return {name: "Edge", version: ua.match(/Edg\/([\d.]+)/)[1]};
    } else if (/SamsungBrowser\/([\d.]+)/.test(ua)) {
        return {
            name: "Samsung Internet", version: ua.match(/SamsungBrowser\/([\d.]+)/),
        };
    } else if (/OPR\/([\d.]+)/.test(ua)) {
        return {name: "Opera", version: ua.match(/OPR\/([\d.]+)/)};
    } else if (/Chrome\/([\d.]+)/.test(ua)) {
        return {name: "Chrome", version: ua.match(/Chrome\/([\d.]+)/)};
    } else if (/Firefox\/([\d.]+)/.test(ua)) {
        return {name: "Firefox", version: ua.match(/Firefox\/([\d.]+)/)};
    } else if (/Safari\/([\d.]+)/.test(ua) && !/Chrome/.test(ua)) {
        return {name: "Safari", version: ua.match(/Version\/([\d.]+)/)};
    }

    return {name: "Unknown", version: "Unknown"};
}

async function init() {
    document.body.style.cursor = "progress";
    // Define the current schema

    if ("serviceWorker" in navigator) {
        try {
            const reg = await navigator.serviceWorker.register("/service-worker.js");
            console.log("Service worker registered:", reg.scope);
            if (reg.active && !navigator.serviceWorker.controller) {
                window.location.reload();
            }
        } catch (err) {
            console.warn("Service worker registration failed:", err);
        }
    }

    db.version(3).stores({
        accounts: "++autoId, id, instance, isActive, updatedAt", settings: "key",
    });

    await db.open();

    features.device = await getDeviceType();

    await versionCheck();

    if (features.device === "phone" || features.device === "tablet") {
        // initNavigation();
    }

    await loadSettings();

    const aiToggle = document.getElementById("ai-toggle");
    if (aiToggle) {
        aiToggle.checked = aiEnabled === true;

        if (features.wasm) {
            if (document.getElementById("ai-models")) {
                document
                    .getElementById("ai-models")
                    .addEventListener("change", async (e) => {

                        await saveSetting("aiKind", e.target.value);

                        document.getElementById("ai-size").disabled = e.target.value !== "wllama";
                    });
            }

            if (await db.table("settings").get("aiKind")) {

                let selection = ["web", "wllama", "local"].indexOf((await db.table("settings").get("aiKind")).value)
                if (selection === undefined || selection === -1 || selection === null) {
                    selection = 1;
                }

                document.getElementById("ai-models").selectedIndex = selection;

                if (document.getElementById("ai-models").selectedIndex === 1) {
                    document.getElementById("ai-size").disabled = false;
                }
            } else {
                document.getElementById("ai-models").selectedIndex = 1;
                await saveSetting("aiKind", "wllama");
                document.getElementById("ai-size").disabled = false;
            }

            if (document.getElementById("ai-size")) {
                document
                    .getElementById("ai-size")
                    .addEventListener("change", async (e) => {
                        await saveSetting("aiSize", e.target.value);
                    });
            }

            if (await db.table("settings").get("aiSize")) {
                document.getElementById("ai-size").selectedIndex = ["small", "default", "large"].indexOf((await db.table("settings").get("aiSize")).value) || 1;
            } else {
                document.getElementById("ai-size").selectedIndex = 1;
                await saveSetting("aiSize", "default");
            }
        }

        aiToggle.addEventListener("change", async (e) => {
            aiEnabled = !!e.target.checked;

            await saveSetting("aiEnabled", aiEnabled);

            if (aiEnabled && !ai) {
                await initAI();
            }
        });
    }

    // Auto-init if previously enabled
    if (aiEnabled) {
        await initAI();
    }
    // NSFW toggle UI logic
    if (document.getElementById("nsfw-toggle")) {
        document.getElementById("nsfw-toggle").addEventListener("change", async (e) => {
            await saveSetting("nsfwEnabled", e.target.checked);
            nsfwEnabled = e.target.checked;
            if (nsfwEnabled) {
                await removeNSFWFilter();
            } else {
                await createNSFWFilter();
            }
        });
        document.getElementById("nsfw-toggle").checked = nsfwEnabled;
    }

    await resetGUI(false);
}

init();

/*
The /api/v1/timelines/tag/:tag endpoint returns public posts tagged with a specific hashtag, and filters created via /api/v2/filters do not apply to tag timelines. 
Filters only affect:
Home timeline
Notifications
Public timeline
Conversations
They do not block or hide posts returned from tag searches or hashtag timelines. 
This is by design: tag timelines are considered exploratory and unfiltered.
We filter them ourselves before we show the statuses */
async function removeNSFWFilter() {
    if (!currentAccount) {
        console.error("No current account available for creating NSFW filter.");
        return;
    }
    try {
        // Step 1: Get all filters
        const filtersResponse = await fetch(currentAccount.instance + "/api/v2/filters", {
            method: "GET", headers: {
                "Authorization": `Bearer ${currentAccount.token}`
            }
        });

        const filters = await filtersResponse.json();
        const nsfwFilter = filters.find(f => f.title === "NSFW Filter");

        if (!nsfwFilter) {
            console.log("NSFW Filter not found.");
            return;
        }

        // Step 2: Delete the filter
        await fetch(`${currentAccount.instance}/api/v2/filters/${nsfwFilter.id}`, {
            method: "DELETE", headers: {
                "Authorization": `Bearer ${currentAccount.token}`
            }
        });

        console.log("NSFW Filter removed successfully.");
    } catch (error) {
        console.error("Error removing NSFW Filter:", error);
    }
}

async function createNSFWFilter() {
    if (!currentAccount) {
        console.error("No current account available for creating NSFW filter.");
        return;
    }
    const filterPayload = {
        title: "NSFW Filter", context: ["home", "notifications", "public"], filter_action: "hide", // or "warn"
        expires_in: null // set to a number of seconds if you want it to expire
    };

    const keywords = ["nsfw", "18+", "explicit", "lewd", "adult"];

    try {
        // Step 1: Create the filter
        const filterResponse = await fetch(currentAccount.instance + "/api/v2/filters", {
            method: "POST", headers: {
                "Authorization": `Bearer ${currentAccount.token}`, "Content-Type": "application/json"
            }, body: JSON.stringify(filterPayload)
        });

        const filterData = await filterResponse.json();
        const filterId = filterData.id;

        // Step 2: Add keywords to the filter
        for (const keyword of keywords) {
            await fetch(`${currentAccount.instance}/api/v2/filters/${filterId}/keywords`, {
                method: "POST", headers: {
                    "Authorization": `Bearer ${currentAccount.token}`, "Content-Type": "application/json"
                }, body: JSON.stringify({
                    keyword, whole_word: false
                })
            });
        }

        console.log("NSFW filter created successfully.");
    } catch (error) {
        console.error("Error creating NSFW filter:", error);
    }
}

document.getElementById("feed-section").addEventListener("scroll", async () => {
    const container = document.getElementById("feed-items");
    if (!container || isLoadingMore) return;

    // Measure scroll inside the div itself
    const scrollPosition = document.getElementById("feed-section").scrollTop + document.getElementById("feed-section").clientHeight;
    const threshold = document.getElementById("feed-section").scrollHeight - 100;

    if (scrollPosition >= threshold && max_id && currentAccount?.instance && currentAccount?.token) {
        isLoadingMore = true;

        await updateTimeline(false);
        isLoadingMore = false;
    }
});

function selectFeed(feed) {
    document.querySelectorAll(".feed-top-btn").forEach((el) => {
        el.classList.remove("active");
    });

    document.getElementById(feed).classList.add("active");
    if (feed !== "search-feed") {
        document.getElementById("search-feed-span").innerText = `Search`;
    }
}

document.getElementById("refresh-feed").addEventListener("click", async () => {
    await updateTimeline();
});
document.getElementById("popular-feed").addEventListener("click", async () => {
    selectFeed("popular-feed");
    currentMode = {
        type: "trending", modifier: null,
    };
    await updateTimeline();
});

if (document.getElementById("recommended-feed")) {
    document
        .getElementById("recommended-feed")
        .addEventListener("click", async () => {
            if (ai && aiEnabled) {
                selectFeed("recommended-feed");

                currentMode = {
                    type: "recommendation", modifier: null,
                };
                const topics = await ensureTopicsForCurrentAccount()
                if (topics === false || !topics || topics.length === 0) {
                    showDebug("No topics found for current account. Please add some.");
                    return;
                }

                await updateTimeline();
                return;
            }

            showDebug("Recommendation feed is only available when AI features are enabled.");

        });
}

document.getElementById("home-feed").addEventListener("click", async () => {
    selectFeed("home-feed");
    currentMode = {
        type: "home", modifier: null,
    };
    await updateTimeline();
});

document.getElementById("search-feed").addEventListener("click", async () => {
    document.getElementById("search-feed").classList.add("active");
    const dlg = document.getElementById("search-dialog");
    dlg.showModal();
});

document.getElementById("cancel-search-btn").addEventListener("click", () => {
    document.getElementById("search-dialog").close();
});
document
    .getElementById("search-input")
    .addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
            event.preventDefault();
            document.getElementById("do-search-btn").click();
        }
    });
document.getElementById("do-search-btn").addEventListener("click", async () => {
    document.getElementById("search-dialog").close();
    currentMode = {
        type: "search_hashtags", modifier: document.getElementById("search-input").value.trim(),
    };
    document.getElementById("search-input").value = "";
    await searchHashtag();
});

// Handle PWA shortcut launches (e.g., "/popular") and initial routing
(function setupPwaLaunchRouting() {
    function routeForUrl(url) {
        try {
            const path = url?.pathname || "/";
            if (path === "/popular") {
                selectFeed("popular-feed");
                currentMode = {type: "trending", modifier: null};
                // Trigger timeline update (safe even if not logged in; function guards internally)
                updateTimeline();
                return true;
            }
        } catch (e) {
            console.warn("Route handling failed:", e);
        }
        return false;
    }

    // 1) Handle initial navigation when app is launched directly to a URL
    try {
        routeForUrl(new URL(window.location.href));
    } catch (_) {
    }

    // 2) Handle subsequent launches via shortcuts when client_mode is focus-existing
    //    Using the Launch Handler API (Edge/Chrome)
    try {
        if ("launchQueue" in window && typeof window.launchQueue.setConsumer === "function") {
            window.launchQueue.setConsumer((launchParams) => {
                try {
                    if (launchParams && launchParams.targetURL) {
                        routeForUrl(new URL(launchParams.targetURL));
                    }
                } catch (e) {
                    console.warn("Launch consumer error:", e);
                }
            });
        }
    } catch (e) {
        console.warn("launchQueue setup failed:", e);
    }
})();

const setFeedContainerPointerEvents = (state) => {
    document.getElementById("feed-container").style.pointerEvents = state === "open" ? "none" : "auto";
};

const addToggleListener = (sectionId) => {
    document.getElementById(sectionId).addEventListener("toggle", (e) => {
        setFeedContainerPointerEvents(e.newState);
        if (e.newState !== "open") {
            history.back();
        }
    });
};

const addFooterClickListener = (footerId, sectionId, historyState, historyUrl) => {
    document.getElementById(footerId)?.addEventListener("click", () => {
        hapticClick();
        openPopover(sectionId)
        // document.getElementById(sectionId).togglePopover();
        //addToHistory(historyState, historyUrl);
    });
};

addFooterClickListener("nav-footer-followers", "nav-followers-section", {showFollowers: true}, "#followers");
addToggleListener("nav-followers-section");

addFooterClickListener("nav-footer-acct", "nav-accounts-section", {showAccounts: true}, "#accounts");
addToggleListener("nav-accounts-section");

addFooterClickListener("nav-footer-hashtags", "nav-hashtags-section", {showHashtags: true}, "#hashtags");
addToggleListener("nav-hashtags-section");

// Add account button handler
document.getElementById("add-account-btn")?.addEventListener("click", () => {
    const dialog = document.getElementById("account-dialog");
    dialog.showModal();
});
document.getElementById("add-account-btn-footer")?.addEventListener("click", () => {
    const dialog = document.getElementById("account-dialog");
    dialog.showModal();
});
document.getElementById("toggleSidebar").addEventListener("click", () => {
    hapticClick();
    document.querySelector(".sidebar").classList.toggle("collapsed");
    document.querySelector("#account-container").removeAttribute("open");
    document.querySelector("#tag-container").removeAttribute("open");
});
document.getElementById("tag-container").addEventListener("toggle", (event) => {
    if (document.getElementById("tag-container").open && document.querySelector(".sidebar").classList.contains("collapsed")) {
        document.querySelector(".sidebar").classList.toggle("collapsed");
    }
});
document.getElementById("hashtag-container").addEventListener("toggle", (event) => {
    if (document.getElementById("hashtag-container").open && document.querySelector(".sidebar").classList.contains("collapsed")) {
        document.querySelector(".sidebar").classList.toggle("collapsed");
    }
});
document
    .getElementById("account-container")
    .addEventListener("toggle", (event) => {
        if (document.getElementById("account-container").open && document.querySelector(".sidebar").classList.contains("collapsed")) {
            document.querySelector(".sidebar").classList.toggle("collapsed");
        }
    });
document.getElementById("settings-button").addEventListener("click", async () => {
    const dialog = document.getElementById("settings-dialog");
    dialog.addEventListener("click", (ev) => {
        hapticClick();
        if (ev.target === dialog) {
            dialog.close();
        }
    });
    dialog.showModal();
});
// Account dialog form submission handler
document
    .getElementById("account-form")
    ?.addEventListener("submit", async (e) => {
        e.preventDefault();

        // Read instance the user entered
        const raw = document.getElementById("instance")?.value || "";
        if (!raw) {
            alert("Please enter a Mastodon instance (e.g. mastodon.social)");
            return;
        }

        // Normalize to origin-like URL (allow host or full URL)
        let instanceUrl = raw.trim();
        if (!/^https?:\/\//i.test(instanceUrl)) {
            instanceUrl = "https://" + instanceUrl;
        }
        // remove trailing slashes
        instanceUrl = instanceUrl.replace(/\/+$/, "");

        try {
            // Send instance_domain to the server and get an authorize_url back
            const url = new URL(instanceUrl);
            const instanceHost = url.host;
            const channel = new BroadcastChannel("auth_channel");
            const appParams = new URLSearchParams({instance_domain: instanceHost});

            const resp = await fetch(window.location.origin + "/authorize", {
                method: "POST",
                headers: {"Content-Type": "application/x-www-form-urlencoded"},
                body: appParams.toString(),
            });

            if (!resp.ok) {
                throw new Error(`Server returned error: ${resp.status}`);
            }
            const json = await resp.json();
            if (json.authorize_url) {
                // Close the dialog
                document.getElementById("account-dialog").close();

                // Add force_login parameter to force Mastodon to show login screen
                const authorizeUrl = new URL(json.authorize_url);
                authorizeUrl.searchParams.set("force_login", "true");

                // Open OAuth in popup window
                const popup = window.open(authorizeUrl.toString(), "mastodon_oauth", "width=600,height=700");

                // Listen for token message from callback

                channel.onmessage = async (event) => {
                    // window.addEventListener("message", async (event) => {
                    if (event.origin !== window.location.origin) return;
                    if (event.data.type === "oauth_token") {
                        const token = event.data.access_token;
                        const instance = "https://" + instanceHost;

                        // Fetch account info from Mastodon
                        try {
                            const accountResp = await fetch(instance + "/api/v1/accounts/verify_credentials", {
                                headers: {Authorization: `Bearer ${token}`},
                            });

                            if (accountResp.ok) {
                                const accountData = await accountResp.json();

                                // Check if account already exists
                                const existingAccount = await db.accounts
                                    .where("id")
                                    .equals(accountData.id)
                                    .first();

                                if (existingAccount) {
                                    alert("This account is already logged in!");
                                    return;
                                }

                                // Deactivate all other accounts
                                await db.accounts.toCollection().modify({isActive: 0});

                                // Create new account
                                const newAccount = new MastodonAccount({
                                    id: accountData.id,
                                    name: accountData.display_name || accountData.username,
                                    accountName: "@" + accountData.acct,
                                    image: accountData.avatar,
                                    token: token,
                                    instance: instance,
                                    isActive: 1,
                                });

                                await db.accounts.add(newAccount.serialize());

                                await resetGUI();
                            }
                        } catch (err) {
                            console.error("Failed to fetch account info:", err);
                            alert("Failed to fetch account information");
                        }
                    }
                };

                return;
            }
            throw new Error("No authorize_url returned from server");
        } catch (err) {
            console.error(err);
            alert("Failed to start login: " + err.message);
        }
    });

async function resetGUI(timelineReset = true) {
    closeToot();
    document.getElementById("search-feed-span").innerText = `Search`;

    await loadAccounts();

    updateTimeline(timelineReset, true);

    loadHashtags();

    loadFollowers();

    if (document.getElementById("search-feed")) {
        if (currentAccount) {
            document.getElementById("search-feed").classList.remove("hidden");
        } else {
            document.getElementById("search-feed").classList.add("hidden");
        }
    }
    if (document.getElementById("recommended-feed")) {
        if (currentAccount) {
            document.getElementById("recommended-feed").classList.remove("hidden");
        } else {
            document.getElementById("recommended-feed").classList.add("hidden");
        }
    }
}

// Cancel button handler
document
    .getElementById("cancel-account-dialog")
    ?.addEventListener("click", () => {
        document.getElementById("account-dialog").close();
    });

// Logout handler for Mastodon (client-only)
async function logoutMastodon() {
    try {
        await db.table("accounts").clear();
    } catch (_) {
    }
    document.getElementById("analyze-feed").classList.add("hidden");
    currentStatuses = [];
    currentStatus = null;
    // Clear only feed items so top controls remain intact
    document.getElementById("feed-items").innerHTML = "";
    document.getElementById("toot-section").innerHTML = "";
    document.getElementById("instance-input")?.focus();
    try {
        console.log("Logged out locally. To fully revoke access, remove Nebulink from your Mastodon account's authorized apps.");
    } catch (_) {
    }
    // Ensure user has provided favorite topics for recommendation filtering
    try {
        await ensureTopicsForCurrentAccount();
    } catch (e) {
        console.warn("ensureTopicsForCurrentAccount failed", e);
    }
}

document.getElementById("logout")?.addEventListener("click", (e) => {
    e.preventDefault();
    logoutMastodon();
});

// Format dates like "52 minutes ago"
function formatRelativeTime(dateInput) {
    try {
        const date = new Date(dateInput);
        const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
        const rtf = new Intl.RelativeTimeFormat(undefined, {numeric: "auto"});
        const units = [["year", 60 * 60 * 24 * 365], ["month", 60 * 60 * 24 * 30], ["week", 60 * 60 * 24 * 7], ["day", 60 * 60 * 24], ["hour", 60 * 60], ["minute", 60], ["second", 1],];
        for (const [unit, secondsInUnit] of units) {
            if (Math.abs(diffSec) >= secondsInUnit || unit === "second") {
                const value = -Math.round(diffSec / secondsInUnit);
                return rtf.format(value, unit);
            }
        }
    } catch (e) {
    }
    return new Date(dateInput).toLocaleString();
}

// ===== Account Management Functions =====
async function loadAccounts() {
    try {
        const accounts = await db.accounts.toArray();
        if (accounts && accounts.length > 0) {
            renderAccounts(accounts);
            currentAccount = await db.accounts.where("isActive").equals(1).first();
        } else {
            currentAccount = null;
        }
    } catch (error) {
        console.error("Failed to load accounts:", error);
    }
}


function renderAccounts(accounts) {
    const container = document.getElementById("accounts-list");
    const containerFooter = document.getElementById("accounts-list-footer");
    const template = document.getElementById("account-card-template");

    container.innerHTML = "";
    containerFooter.innerHTML = "";

    for (const account of accounts) {
        const node = template.content.cloneNode(true);
        const card = node.querySelector(".account-card");

        // Set account data
        const avatar = node.querySelector(".account-avatar");
        const name = node.querySelector(".account-name");
        const handle = node.querySelector(".account-handle");
        const instance = node.querySelector(".account-instance");
        const logoutBtn = node.querySelector(".account-logout-btn");

        avatar.src = account.image || "/static/nebulink/assets/default-avatar.png";
        name.textContent = account.name || "Unknown";
        handle.textContent = account.accountName || "@unknown";
        instance.textContent = account.instance || "";

        // Mark active account
        if (account.isActive) {
            card.classList.add("active");
        }
        const newClone = node.cloneNode(true)
        const logoutBtnFooter = newClone.querySelector(".account-logout-btn");
        const cardFooter = newClone.querySelector(".account-card");

        // Click to switch account
        [card, cardFooter].forEach(el => {
            el.addEventListener("click", async (e) => {
                if (e.target.closest(".account-logout-btn")) return;
                await switchAccount(account.autoId);
            });
        });

        // Logout button
        [logoutBtn, logoutBtnFooter].forEach(el => {
            el.addEventListener("click", async (e) => {
                e.stopPropagation();
                await logoutAccount(account.autoId);
                //delete from GUI
                container.remove(node);
                containerFooter.remove(node);
            });
        });

        container.appendChild(node);
        containerFooter.appendChild(newClone);
    }
}

/**
 * If the current active account has no topics saved, prompt the user to add up to 20 topics.
 */
async function ensureTopicsForCurrentAccount() {
    if (!currentAccount) return;
    // reload fresh from db to ensure we have latest fields
    const acct = await db.accounts.get(currentAccount.autoId || currentAccount.id);
    if (!acct) return;
    currentAccount = acct;
    if (acct.topics && Array.isArray(acct.topics) && acct.topics.length > 0) {
        return acct.topics;
    }

    // show dialog to collect topics
    showTopicsDialog();
    return false
}

function showTopicsDialog() {
    const dlg = document.getElementById("topics-dialog");
    const input = document.getElementById("topics-input");
    if (!dlg || !input) return;
    input.value = "";
    dlg.addEventListener("click", (ev) => {
        if (ev.target === dlg) dlg.close();
    });
    dlg.showModal();
}

// Save topics handler
document.getElementById("save-topics")?.addEventListener("click", async () => {
    const input = document.getElementById("topics-input");
    const dlg = document.getElementById("topics-dialog");
    if (!input || !dlg) return;
    const raw = input.value || "";
    const topics = raw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .slice(0, 20);
    if (!currentAccount || !currentAccount.autoId) {
        // try to reload active account
        currentAccount = await db.accounts.where("isActive").equals(1).first();
    }
    if (currentAccount && currentAccount.autoId) {
        try {
            await db.accounts.update(currentAccount.autoId, {topics});
            currentAccount.topics = topics;
        } catch (e) {
            console.error("Failed to save topics", e);
        }
    }
    dlg.close();

    showDebug("Topics saved. Reload recommendations to see changes.");
});

// Skip topics handler
document.getElementById("skip-topics")?.addEventListener("click", async () => {
    const dlg = document.getElementById("topics-dialog");
    if (!dlg) return;
    // set empty topics so we don't prompt repeatedly
    if (currentAccount && currentAccount.autoId) {
        try {
            await db.accounts.update(currentAccount.autoId, {topics: []});
            currentAccount.topics = [];
        } catch (e) {
            console.error("Failed to save empty topics", e);
        }
    }
    dlg.close();
});

async function switchAccount(accountId) {
    try {
        // Deactivate all accounts
        await db.accounts.toCollection().modify({isActive: 0});

        // Activate selected account
        await db.accounts.update(accountId, {isActive: 1});

        currentAccount = await db.accounts.get(accountId);
        await resetGUI();
    } catch (error) {
        console.error("Failed to switch account:", error);
    }
}

async function logoutAccount(accountId) {
    if (!confirm("Are you sure you want to log out of this account?")) {
        return;
    }

    try {
        await db.accounts.delete(accountId);

        // If this was the active account, activate another one
        const remainingAccounts = await db.accounts.toArray();
        if (remainingAccounts.length > 0) {
            const wasActive = remainingAccounts.every((acc) => !acc.isActive);
            if (wasActive) {
                await db.accounts.update(remainingAccounts[0].autoId, {isActive: 1});
            }
        }

        currentMode = {
            type: "home", modifier: null,
        };
        await resetGUI();
    } catch (error) {
        console.error("Failed to logout account:", error);
    }
}

async function loadFollowers() {
    ///api/v1/accounts/:id/followers
    try {
        const container = document.getElementById("followers-list");
        const containerFooter = document.getElementById("followers-list-footer");
        if (!currentAccount) {
            //console.error("No active account found");
            container.innerHTML = "";
            containerFooter.innerHTML = "";
            return;
        }
        const r = await fetch(currentAccount.instance + `/api/v1/accounts/${currentAccount.id}/following `, {
            method: "GET", headers: {Authorization: `Bearer ${currentAccount.token}`},
        });
        if (r.ok) {
            // const linkHeader = r.headers.get('Link');
            const followers = await r.json();
            container.innerHTML = "";
            containerFooter.innerHTML = "";
            for (const follower of followers) {
                const followerEl = document.createElement("div");
                followerEl.className = "follower-item";
                followerEl.id = `followed-${follower.display_name || follower.username}`;
                const avatarEl = document.createElement("img");
                avatarEl.className = "follower-avatar";
                avatarEl.src = follower.avatar_static;
                const nameEl = document.createElement("div");
                nameEl.className = "follower-name";
                nameEl.textContent = follower.display_name || follower.username;
                followerEl.appendChild(avatarEl);
                followerEl.appendChild(nameEl);
                const followerElFooter = followerEl.cloneNode(true);
                [followerEl, followerElFooter].forEach(el => {
                    el.addEventListener("click", async (e) => {
                        selectFeed(`followed-${follower.display_name || follower.username}`);
                        document.getElementById("search-feed-span").innerText = `Search`;
                        currentMode = {
                            type: "account", modifier: follower.id,
                        };
                        await updateTimeline();
                    });
                });
                container.appendChild(followerEl);
                containerFooter.appendChild(followerElFooter);
            }
        } else {
            console.error("Failed to fetch followers " + r.status);
        }
    } catch (e) {
        console.error("Failed to load followers", e);
    }
}

async function loadHashtags() {
    //"/api/v1/followed_tags"
    //hashtag-list
    try {
        const container = document.getElementById("hashtag-list");
        const containerFooter = document.getElementById("hashtags-list-footer");
        if (!currentAccount) {
            //console.error("No active account found");
            container.innerHTML = "";
            containerFooter.innerHTML = "";
            return;
        }
        const r = await fetch(currentAccount.instance + `/api/v1/followed_tags`, {
            method: "GET", headers: {Authorization: `Bearer ${currentAccount.token}`},
        });
        if (r.ok) {
            // const linkHeader = r.headers.get('Link');
            const hashtags = await r.json();
            container.innerHTML = "";
            containerFooter.innerHTML = "";
            for (const tag of hashtags) {
                const tagEl = document.createElement("div");
                tagEl.className = "hashtag-item";
                tagEl.id = `hashtag-${tag.name}`;
                tagEl.title = `#${tag.name}`;
                tagEl.ariaLabel = `#${tag.name}`;
                tagEl.textContent = `#${tag.name}`;

                const tagElFooter = tagEl.cloneNode(true);
                [tagEl, tagElFooter].forEach(el => {
                    el.addEventListener("click", async () => {
                        selectFeed(`hashtag-${tag.name}`);
                        document.getElementById("search-feed-span").innerText = `Search`;
                        currentMode = {
                            type: "hashtag", modifier: tag.name,
                        };
                        await updateTimeline();
                    });
                });
                container.appendChild(tagEl);
                containerFooter.appendChild(tagElFooter);
            }
        } else {
            console.error("Failed to fetch followed hashtags " + r.status);
        }
    } catch (e) {
        console.error("Failed to load followed hashtags", e);
    }
}

//=========== FEED LOGIC ===========
async function searchHashtag() {
    try {
        document.body.style.cursor = "progress";
        //serach for hashtags and display results
        //then do await updateTimeline(); for selected hashtag and add it as button to top

        if (!currentAccount) {
            console.error("No active account found");
            return;
        }
        const hashtag = currentMode.modifier;
        if (!hashtag) {
            console.error("No hashtag specified for search");
            return;
        }
        let url = currentAccount.instance + apiURLs[currentMode.type].replace("{0}", currentMode.modifier)
        const r = await fetch(url, {
            method: "GET", headers: {Authorization: `Bearer ${currentAccount.token}`},
        });
        if (r.ok) {
            let result = await r.json();
            //show dialog hashtag-search-result
            const resultsDlg = document.getElementById("hashtag-search-results");
            const container = document.getElementById("hashtag-search-container");
            container.innerHTML = "";
            if (result.hashtags) {
                result = result.hashtags;
            }
            for (const hashtag of result) {
                const btn = document.createElement("button");
                btn.className = "hashtag-search-item";
                btn.textContent = `#${hashtag.name}`;
                btn.title = `#${hashtag.name}`;
                btn.ariaLabel = `#${hashtag.name}`;
                btn.addEventListener("click", async () => {
                    selectFeed("search-feed");
                    resultsDlg.close();
                    currentMode = {
                        type: "hashtag", modifier: hashtag.name,
                    };
                    document.getElementById("search-feed-span").innerText = `Search - #${hashtag.name}`;
                    await updateTimeline();
                });
                container.appendChild(btn);
            }
            resultsDlg.show();
        } else {
            console.error("Failed to search hashtag " + r.status);
        }
    } catch (e) {
        console.error("Failed to search hashtag", e);
    }
    document.body.style.cursor = "default";
}

async function updateTimeline(doReset = true) {
    ProgressManager.start(100, "Loading feed…");
    try {
        //add loading spinner to mouse
        let loadMoreBtn = document.getElementById("load-more-btn");
        if (loadMoreBtn) {
            loadMoreBtn.remove();
        }
        document.body.style.cursor = "progress";

        if (doReset) {
            offset = 0;
            max_id = null;
            document.getElementById("analyze-feed").classList.add("hidden");
            currentStatuses = [];
        }

        // Get active account from database

        if (!currentAccount) {
            currentAccount = await db.accounts.where("isActive").equals(1).first();

        }


        const instance = currentAccount?.instance || null;
        const token = currentAccount?.token || null;
        const apiUrl = currentMode.modifier ? apiURLs[currentMode.type].replace("{0}", currentMode.modifier) : apiURLs[currentMode.type];

        ProgressManager.set(50)
        await loadTimelineForInstance(instance, token, apiUrl);
        ProgressManager.finish();

        if (max_id) {
            const container = document.getElementById("feed-items");

            if (currentMode.type === "recommended") {
                if (currentStatuses.length === 0) {
                    const paragraph = document.createElement("p")
                    paragraph.textContent = "No recommendations found";
                    container.appendChild(paragraph);
                    document.body.style.cursor = "default";
                    return
                }
            }
            loadMoreBtn = document.createElement("button");
            loadMoreBtn.id = "load-more-btn";
            loadMoreBtn.innerHTML = `<span class="material-symbols-outlined">
read_more
</span><span>Load More</span>`;
            loadMoreBtn.addEventListener("click", async function () {
                await updateTimeline(false);
            });
            container.appendChild(loadMoreBtn);
        }
    } catch (e) {
        console.error("Failed to load timelines", e);
    }
    document.body.style.cursor = "default";
}

function closeToot(addHistoryBack = true) {
    if (currentTootId) {
        if (addHistoryBack) {
            history.back();
        }
        currentTootId = null;
    }
    const toot = document.getElementById("toot-section");
    if (!toot) {
        return;
    }
    const card = toot.querySelector(".article-card");
    if (!card) {
        // Fallback to previous immediate close
        toot.parentElement.classList.remove("expanded");
        toot.innerHTML = "";
        toot.classList.add("hidden");
        const selectedEl = document.getElementById(currentTootId);
        if (selectedEl) selectedEl.classList.remove("selected");
        return;
    }
    // Start leave animation
    card.classList.remove("article-enter", "article-enter-active");
    card.classList.add("article-leave-active");
    const onDone = () => {
        card.removeEventListener("transitionend", onDone);
        toot.parentElement.classList.remove("expanded");
        toot.innerHTML = "";
        toot.classList.add("hidden");
        const selectedEl = document.getElementById(currentTootId);
        if (selectedEl) selectedEl.classList.remove("selected");
        // Clean classes for next open
        card.classList.remove("article-leave-active");
    };
    card.addEventListener("transitionend", onDone, {once: true});
}

async function renderStatuses(statuses) {
    const container = document.getElementById("feed-items");
    const template = document.getElementById("feed-template");

    if (!statuses || statuses.length === 0) {
        const paragraph = document.createElement("p");
        paragraph.textContent = "No content found for this feed";
        container.appendChild(paragraph);
        return [];
    }

    let renderedStatuses = [];
    for (const s of statuses) {
        if (!s.content) {
            continue;
        }

        if (!nsfwEnabled) {
            let skip = false;
            for (const nsfwWord of nsfwWords) {
                if (s.tags && s.tags.includes(nsfwWord.toLowerCase())) {
                    skip = true
                    break;
                }
                // Check if the word appears as a whole word in the content
                const regex = new RegExp(`\\b${nsfwWord.toLowerCase()}\\b`, "i");
                if (regex.test(s.content)) {
                    skip = true;
                    break;
                }
            }
            if (skip) {
                continue;
            }
        }

        renderedStatuses.push(s);
        const node = template.content.cloneNode(true);

        const actualStatus = node.querySelector(".masto-status");
        actualStatus.id = s.id;


        const body = node.querySelector(".status-body");
        body.id = s.id;

        const avatar = node.querySelector(".status-avatar");
        avatar.id = s.id;
        const display = node.querySelector(".status-display_name");

        const acct = node.querySelector(".status-acct");

        const dateEl = node.querySelector(".status-date");

        const content = node.querySelector(".status-content");

        const likeButton = node.querySelector(".status-like-button");
        const translateButton = node.querySelector(".status-translate-button");

        const othersLiked = node.querySelector(".status-like-count");

        if (s.account && s.account.avatar_static) {
            avatar.src = s.account.avatar_static;
        }
        if (s.account && s.account.display_name.length > 20) {
            s.account.display_name = s.account.display_name.substring(0, 17) + "...";
        }
        if (s.account && s.account.acct.length > 30) {
            s.account.acct = s.account.acct.substring(0, 27) + "...";
        }
        if (s.account && s.account.username.length > 30) {
            s.account.username = s.account.username.substring(0, 27) + "...";
        }
        display.textContent = s.account?.display_name || s.account?.username || "";
        acct.textContent = "@" + (s.account?.acct || s.account?.username || "");
        dateEl.textContent = formatRelativeTime(s.created_at);
        content.innerHTML = s.content || "";
        actualStatus.title = s.content || "No text data";
        othersLiked.textContent = s.favourites_count;

        if (features.device !== "watch") {
            const icon = likeButton.querySelector(".material-icons-outlined");
            if (s.favourited) {
                icon.textContent = "favorite";
                icon.classList.remove("active");
                likeButton.setAttribute("aria-label", "Unlike post");
            } else {
                icon.textContent = "favorite_border";
                icon.classList.add("active");
                likeButton.setAttribute("aria-label", "Like post");
            }
        } else {
            likeButton.remove()
        }

        const commentCountEl = node.querySelector(".status-comments-count");
        addToCommentsQueue(currentAccount ? currentAccount.instance : null, s, currentAccount ? currentAccount.token : null, (a) => {
            s.comments = a;
            if (commentCountEl) {
                commentCountEl.textContent = s.comments ? s.comments.length : 0;
            }
        });

        const parser = new DOMParser();
        const doc = parser.parseFromString(s.content, "text/html");
        const rawText = doc.body.textContent || doc.body.innerText;

        if (s.poll) {
            console.log(s.poll);
        }

        if (ai == null || !ai.detector) {
            if (s.language === "en" || !currentAccount) {
                translateButton.remove();
            }
        } else {
            ai.addToLangDetQueue({rawText, translateButton, s});
        }

        translateButton.addEventListener("click", async () => {
            const icon = translateButton.querySelector(".material-symbols-outlined");

            // Show spinner (using a CSS class or SVG)
            icon.textContent = "";
            icon.classList.add("spinner");

            let translation;
            if (ai && ai.translate) {
                translation = (await translateIfAvailable(s.detectedLanguage, rawText)) || (await translateIfAvailable(s.language, rawText));
            }
            if (!translation) {
                translation = await getTranslationFromMastodon(s);
            }
            content.innerHTML = translation;
            actualStatus.title = translation;
            s.content = translation;
            if (currentTootId === s.id) {
                const tootContent = document.querySelector("#toot-section .article-content");
                if (tootContent) {
                    tootContent.innerHTML = translation;
                }
            }
            translateButton.remove();
        });

        actualStatus.addEventListener("click", async (e) => {
            if (e.target.closest(".status-footer")) {
                return;
            }

            hapticClick();

            const status = e.target.closest(".masto-status");
            const selected = document
                .getElementById("feed-items")
                .querySelector(".selected");

            if (selected) {
                selected.classList.remove("selected");
            }

            const toot = document.getElementById("toot-section");
            toot.classList.remove("hidden");
            toot.parentElement.classList.add("expanded");

            status.classList.add("selected");
            currentTootId = e.currentTarget.id;
            await renderStatus(translateButton, actualStatus, content, othersLiked, likeButton);
            // actualStatus.scrollIntoViewIfNeeded();

            //addToHistory({showToot: true, id: actualStatus.id}, "#toot-open");
        });

        container.appendChild(node);
    }

    return renderedStatuses;
}

function openPopover(id) {
    const popover = document.getElementById(id);
    if (popover && typeof popover.showPopover === "function") {
        popover.showPopover();
        history.pushState({popover: id}, "", "");
    }
}

window.addEventListener("popstate", () => {
    const popovers = [
        "nav-followers-section",
        "nav-accounts-section",
        "nav-hashtags-section"
        // Add other popover IDs here
    ];
    popovers.forEach(id => {
        const pop = document.getElementById(id);
        const open = pop.matches(':popover-open');
        if (pop && typeof pop.togglePopover === "function" && open) {
            pop.togglePopover();
            history.pushState({}, "", "");
        }
    });
    if (document.getElementById("toot-section").innerHTML !== "") {
        closeToot(false);
    }
});

async function getTranslationFromMastodon(s) {
    try {
        const r = await fetch(currentAccount.instance + `/api/v1/statuses/${s.id}/translate`, {
            method: "POST", headers: {Authorization: `Bearer ${currentAccount.token}`},
        });
        if (r.ok) {
            const json = await r.json();
            if (json.content) {
                // showDebug(json.content);
                return json.content;
            }
            showDebug("error");
            return null;
        } else {
            const error = await r.json();
            showDebug(error.error);
            //error status 503 means mastodon instance does not support translation
            if (r.status === 403) {
                alert("Translation request failed: Language not supported");
            } else if (r.status === 503) {
                // error status 503 means Mastodon instance does not support translation
                alert("Translation is not supported by this Mastodon instance (error 503).");
            } else {
                console.error("Translation request failed with status " + r.status + " " + error.error);
                alert("Translation request failed: " + (error.error || "Unknown error"));
            }
            return null;
        }
    } catch (e) {
        showDebug("failed " + e.message);
        console.error("Translation failed", e);
    }
}

async function translateIfAvailable(sourceLng, rawText) {
    const available = await ai.translatorAvailable(sourceLng, "en");
    if (available === "available" || available === "downloadable") {
        return await ai.translate(sourceLng, "en", rawText);
    }
    return null;
}

async function renderStatus(listTranslateBtn, listStatusEl, listContentEl, othersLiked, listLikeBtn) {
    const id = currentTootId;
    history.pushState({tootid: currentTootId}, "", "");
    document.getElementById("toot-section").innerHTML = "";
    const s = currentStatuses.filter((status) => status.id === id)[0];

    const articleElement = document
        .getElementById("article-template")
        .content.cloneNode(true);

    // Prefer the first image attachment as the article image; fall back to avatar if none
    const imgEl = articleElement.querySelector(".article-image");
    const vidEl = articleElement.querySelector(".article-video");
    try {
        const attachments = Array.isArray(s.media_attachments) ? s.media_attachments : [];
        const firstImage = attachments.find((a) => (a?.type === "image") && (a?.url || a?.preview_url));
        if (firstImage) {
            // For images use url; for gifv/video use preview_url as a poster
            imgEl.src = firstImage.url;
            if (firstImage.description) imgEl.alt = firstImage.description;
        } else if (s.card && (s.card.image || s.card.image_url)) {
            // Fallback: link preview card image if present
            imgEl.src = s.card.image || s.card.image_url;
            if (s.card.title) imgEl.alt = s.card.title;
        } else {
            articleElement.querySelector(".article-image").remove();
        }
    } catch (e) {
        articleElement.querySelector(".article-image").remove();
    }

    try {
        const attachments = Array.isArray(s.media_attachments) ? s.media_attachments : [];
        const firstVideo = attachments.find((a) => (a?.type === "video" || a?.type === "gifv") && (a?.url || a?.preview_url));
        if (firstVideo) {
            vidEl.src = firstVideo.url;
            const image = articleElement.querySelector(".article-image");
            if (image) {
                image.remove();
            }

            vidEl.load();

        } else {
            articleElement.querySelector(".article-video").remove();
        }
    } catch (e) {
        articleElement.querySelector(".article-video").remove();
    }


    const articleAvatar = articleElement.querySelector(".article-avatar");
    if (articleAvatar && s.account && s.account.avatar_static) {
        articleAvatar.src = s.account.avatar_static;
        articleAvatar.alt = s.account.display_name || s.account.username || "author avatar";
    }
    articleElement.querySelector(".article-author").textContent = s.account.display_name;
    articleElement.querySelector(".article-date").textContent = new Date(s.created_at).toLocaleDateString();
    articleElement.querySelector(".article-content").innerHTML = s.content;

    articleElement
        .querySelector(".article-close-button")
        .addEventListener("click", () => {
            closeToot();
        });

    const comments = s.comments;
    const likeBtn = articleElement.querySelector("#like");

    if (features.device !== "watch") {

        const icon = likeBtn.querySelector(".material-icons-outlined");
        if (s.favourited) {
            icon.textContent = "favorite";
            likeBtn.setAttribute("aria-label", "Unlike post");
        } else {
            icon.textContent = "favorite_border";
            likeBtn.setAttribute("aria-label", "Like post");
        }
        likeBtn.addEventListener("click", async () => {
            if (!currentAccount) {
                //todo: show error msg please log in
                return;
            }
            const listIcon = listLikeBtn.querySelector(".material-icons-outlined");
            othersLiked.innerHTML = parseInt(othersLiked.innerHTML) + 1;
            if (s.favourited) {
                listIcon.textContent = "favorite_border";
                listIcon.classList.remove("active");
                listLikeBtn.setAttribute("aria-label", "Like post");
                icon.textContent = "favorite_border";
                icon.classList.remove("active");
                likeBtn.setAttribute("aria-label", "Like post");
                s.favourited = false;
                s.favourites_count -= 1;
                othersLiked.innerHTML = s.favourites_count;
                await updateFavouriteState(s.id, false);
            } else {
                icon.textContent = "favorite";
                icon.classList.add("active");
                likeBtn.setAttribute("aria-label", "Unlike post");
                listIcon.textContent = "favorite";
                listIcon.classList.add("active");
                listLikeBtn.setAttribute("aria-label", "Unlike post");
                s.favourited = true;
                s.favourites_count += 1;
                othersLiked.innerHTML = s.favourites_count;
                await updateFavouriteState(s.id, true);
            }
        });
    }
    const translateButton = articleElement.querySelector("#translate");
    if (!listTranslateBtn.parentNode) {
        if (features.device === "watch") {
            if (s.language === "en" || s.detectedLanguage === "en") {
                translateButton.remove();
            } else {
                translateButton.addEventListener("click", async () => {
                    hapticClick();
                    const icon = translateButton.querySelector(".material-symbols-outlined");

                    // Show spinner (using a CSS class or SVG)
                    icon.textContent = "";
                    icon.classList.add("spinner");

                    //if not english, check if available
                    let translation = await translateOther(s.content, s.language || s.detectedLanguage, "en")
                    if (translation) {
                        const tootContent = document.querySelector("#toot-section .article-content");
                        tootContent.innerHTML = translation;
                        s.content = translation;
                        listContentEl.innerHTML = translation;
                        listStatusEl.title = translation;
                    }
                    listTranslateBtn.remove();
                    translateButton.remove();
                })
            }
        } else {
            translateButton.remove();
        }
    } else {
        translateButton.addEventListener("click", async () => {
            hapticClick();
            const icon = translateButton.querySelector(".material-symbols-outlined");

            // Show spinner (using a CSS class or SVG)
            icon.textContent = "";
            icon.classList.add("spinner");

            //if not english, check if available
            let translation;
            if (ai && ai.translate) {
                translation = (await translateIfAvailable(s.detectedLanguage, s.content)) || (await translateIfAvailable(s.language, s.content));
            }
            if (!translation) {
                translation = await getTranslationFromMastodon(s);
            }
            if (translation) {
                const tootContent = document.querySelector("#toot-section .article-content");
                tootContent.innerHTML = translation;
                s.content = translation;
                listContentEl.innerHTML = translation;
                listStatusEl.title = translation;
            }
            listTranslateBtn.remove();
            translateButton.remove();
        });
    }

    if (!comments || comments.length === 0) {
        articleElement.querySelector("#reply-header").textContent = "No comments";
        articleElement.querySelector("#summarize-comments").remove();
    } else {
        for (const c of comments) {
            const commentElement = document
                .getElementById("comment-template")
                .content.cloneNode(true);

            // avatar
            const commentAvatar = commentElement.querySelector(".comment-avatar");
            if (commentAvatar && c.account && c.account.avatar_static) {
                commentAvatar.src = c.account.avatar_static;
                commentAvatar.alt = c.account.display_name || c.account.username || "commenter avatar";
            }

            // author and content
            const authorEl = commentElement.querySelector(".comment-author");
            if (authorEl) authorEl.textContent = c.account?.display_name || c.account?.username || "";
            const contentEl = commentElement.querySelector(".comment-content");
            if (contentEl) contentEl.innerHTML = c.content || "";

            // relative timestamp
            const tsEl = commentElement.querySelector(".comment-timestamp");
            if (tsEl) tsEl.textContent = formatRelativeTime(c.created_at);

            //like button
            const commentLikeBtn = commentElement.querySelector(".comment-actions");
            if (c.favourited) {
                const icon = commentLikeBtn.querySelector(".material-icons-outlined");
                icon.textContent = "favorite";
                commentLikeBtn.setAttribute("aria-label", "Unlike comment");
            } else {
                const icon = commentLikeBtn.querySelector(".material-icons-outlined");
                icon.textContent = "favorite_border";
                commentLikeBtn.setAttribute("aria-label", "Like comment");
            }
            commentLikeBtn.addEventListener("click", async () => {
                if (!currentAccount) {
                    return;
                }
                const icon = commentLikeBtn.querySelector(".material-icons-outlined");
                if (c.favourited) {
                    icon.textContent = "favorite_border";
                    commentLikeBtn.setAttribute("aria-label", "Like comment");
                    c.favourited = false;
                    await updateFavouriteState(c.id, false);
                } else {
                    icon.textContent = "favorite";
                    commentLikeBtn.setAttribute("aria-label", "Unlike comment");
                    c.favourited = true;
                    await updateFavouriteState(c.id, true);
                }
            });

            // optional media attachment preview
            try {
                const atts = Array.isArray(c.media_attachments) ? c.media_attachments : [];
                const firstImg = atts.find((a) => (a?.type === "image" || a?.type === "gifv" || a?.type === "video") && (a?.preview_url || a?.url));
                if (firstImg) {
                    const mediaEl = commentElement.querySelector(".comment-media");
                    if (mediaEl) {
                        mediaEl.src = firstImg.preview_url || firstImg.url;
                        mediaEl.alt = firstImg.description || "comment media";
                        mediaEl.style.display = "block";
                    }
                }
            } catch (e) {
                /* ignore */
            }

            articleElement
                .querySelector("#comments-section")
                .appendChild(commentElement);
        }
    }

    if (features.device === "watch" || (!features.summarize && !features.wasm)) {
        if (articleElement.querySelector("#summarize")) {
            articleElement.querySelector("#summarize").remove();
        }
        if (articleElement.querySelector("#summarize-comments")) {
            articleElement.querySelector("#summarize-comments").remove();
        }
    } else {
        if (articleElement.querySelector("#summarize")) {
            articleElement
                .querySelector("#summarize")
                .addEventListener("click", async () => {
                    hapticClick();
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(s.content, "text/html");
                    const t = doc.body.textContent;

                    let text = `${s.account.username} Said: ${t} \n\n`;
                    if (!ai && aiEnabled) {
                        await initAI();
                    }
                    if (!ai) {
                        showDebug("AI Features are disabled. Enable them in Settings to use summarization.");
                        return;
                    }
                    ProgressManager.start(1, "Summarizing post...");

                    try {
                        const summary = await ai.summarize(text);

                        if (summary) {
                            showSummary(summary);
                        }
                    } finally {
                        ProgressManager.finish();
                    }
                });
        }
        if (articleElement.querySelector("#summarize-comments")) {
            articleElement
                .querySelector("#summarize-comments")
                .addEventListener("click", async () => {
                    hapticClick();

                    const parser = new DOMParser();
                    const doc = parser.parseFromString(s.content, "text/html");
                    const t = doc.body.textContent;
                    let text = `${s.account.username} Said: ${t} \n\n`;

                    for (const c of comments) {
                        const doc = parser.parseFromString(c.content, "text/html");
                        const t = doc.body.textContent;
                        text += `${c.account.username} Said: ${t} \n\n`;
                    }
                    if (!ai && aiEnabled) {
                        await initAI();
                    }
                    if (!ai) {
                        if (features.device === "phone" || features.device === "watch") {
                            showDebug("AI Features are disabled. Enable them in Settings to use summarization.");
                            return;
                        }
                        alert("AI Features are disabled. Enable them in Settings to use summarization.");
                        return;
                    }
                    ProgressManager.start(1, "Summarizing thread...");

                    try {
                        ProgressManager.start(5, "Summarizing thread...");
                        const summary = await ai.summarize(text);
                        showSummary(summary);
                    } finally {
                        ProgressManager.finish();
                    }
                });
        }
    }

    currentStatus = s;
    // Append the populated element to a container
    document.getElementById("toot-section").appendChild(articleElement);
    // Animate article open
    try {
        const card = document
            .getElementById("toot-section")
            .querySelector(".article-card");
        if (card) {
            card.classList.remove("article-leave-active", "article-enter-active");
            card.classList.add("article-enter");
            requestAnimationFrame(() => {
                // Double RAF to ensure styles apply after layout
                requestAnimationFrame(() => {
                    card.classList.add("article-enter-active");
                    card.classList.remove("article-enter");
                });
            });
        }
    } catch (e) {
        /* no-op */
    }
}

function updateFavouriteState(id, favourited) {
    ///api/v1/statuses/:id/favourite
    ///api/v1/statuses/:id/unfavourite
    const action = favourited ? "favourite" : "unfavourite";
    const url = `${currentAccount.instance}/api/v1/statuses/${id}/${action}`;
    return fetch(url, {
        method: "POST", headers: {
            Authorization: `Bearer ${currentAccount.token}`,
        },
    });
}

document
    .getElementById("ai-result-close-button")
    ?.addEventListener("click", () => {
        hapticClick();
        const dialog = document.getElementById("ai-results");
        if (typeof dialog.close === "function") {
            dialog.close();
        }
    });

function showSummary(text) {
    const tpl = document.getElementById("summary-template");
    const dialog = document.getElementById("ai-results");
    if (!tpl || !dialog) return;
    // clear previous content but preserve the close button if present
    const existingClose = dialog.querySelector("#ai-result-close-button");
    dialog.innerHTML = "";
    if (existingClose) dialog.appendChild(existingClose);
    // clone template and set text
    const node = tpl.content.cloneNode(true);
    const p = node.querySelector("#summary-result") || node.querySelector("p");
    if (p) p.textContent = text;
    dialog.appendChild(node);
    // open dialog
    if (typeof dialog.showModal === "function") {
        dialog.showModal();
    } else {
        dialog.style.display = "block";
    }
}

async function getComments(domain, status, access) {
    if (!domain) {
        domain = "https://mastodon.social";
    }

    let headers = {};
    if (access) {
        headers["Authorization"] = `Bearer ${access}`;
    }

    const r = await fetch(domain + `/api/v1/statuses/${status.id}/context`, {
        method: "GET", headers: headers,
    });
    if (!r.ok) {
        console.log("failed");
        return;
    }
    const rs = await r.json();
    return rs.descendants;
}

async function loadTimelineForInstance(domain, access, apiURL, tryCount = 0) {
    // if (!domain) return;
    let url = domain + apiURL;
    if (!domain) {
        if (currentMode.type === "home" || currentMode.type === "recommendation") {
            url = "https://mastodon.social/api/v1/timelines/public";
        } else {
            url = "https://mastodon.social/api/v1/trends/statuses";
        }
    }
    if (currentMode.type === "trending" && offset > 0) {
        url += url.includes("?") ? `&offset=${offset}` : `?offset=${offset}`;
    } else if (max_id) {
        url += url.includes("?") ? `&max_id=${max_id}` : `?max_id=${max_id}`;
    } else {
        document.getElementById("feed-items").innerHTML = "";
    }
    const headers = {};
    if (access) {
        headers["Authorization"] = `Bearer ${access}`;
    }

    const r = await fetch(url, {
        method: "GET", headers: headers,
    });
    if (!r.ok) {
        console.log("failed");
        isLoadingMore = false;
        return;
    }

    let statuses = await r.json();
    if (currentMode.type === "search" && statuses.statuses) {
        statuses = statuses.statuses;
    }

    // If recommendation mode and user has saved topics, filter statuses by user's topics using ai.classifyTopics
    if (currentMode.type === "recommendation" && currentAccount && Array.isArray(currentAccount.topics) && currentAccount.topics.length > 0) {
        let startedProgress = false;
        try {
            // Start a progress bar for recommendation filtering
            if (Array.isArray(statuses) && statuses.length > 0) {
                ProgressManager.start(statuses.length, "Filtering recommendations...");
                startedProgress = true;
            }

            // ensure AI available; if not, try to init if enabled
            if (!ai && aiEnabled) {
                try {
                    await initAI();
                } catch (e) {
                    console.warn("initAI failed for recommendation filtering", e);
                }
            }

            const userTopicsLC = currentAccount.topics.map((t) => t.toLowerCase().trim());
            const filtered = [];

            for (const s of statuses) {
                try {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(s.content || "", "text/html");

                    const raw = doc.body.textContent || "";

                    if (raw === "") {
                        continue;
                    }

                    if (ai && typeof ai.classifyTopics === "function") {
                        const res = await ai.classifyTopics(raw);
                        const topics = (res && res.topics) || [];
                        const match = topics.some((tt) => userTopicsLC.includes((tt || "").toLowerCase().trim()));
                        if (match) filtered.push(s);
                    }
                } catch (e) {
                    console.warn("recommendation filtering error", e);
                } finally {
                    if (startedProgress) {
                        ProgressManager.tick(1);
                    }
                }
            }
            statuses = filtered;
        } finally {
            if (startedProgress) {
                ProgressManager.finish();
            }
        }
    }

    max_id = statuses[statuses.length - 1]?.id || null;
    isLoadingMore = false;
    let thisRenderedStatuses = await renderStatuses(statuses);

    currentStatuses = currentStatuses.concat(thisRenderedStatuses);
    if (currentStatuses.length > 0) {
        if (features.device === "xr") {
            document.getElementById("enterVRButton").visibility = "visible";
        }
        if (features.device !== "watch" && aiEnabled && ai && currentMode.type !== "recommendation" && currentMode.type !== "search") {
            document.getElementById("analyze-feed").classList.remove("hidden");
        } else {
            document.getElementById("analyze-feed").classList.add("hidden");
        }
    } else {
        document.getElementById("analyze-feed").classList.add("hidden");
        document.getElementById("enterVRButton").visibility = "hidden";
    }


    offset += statuses.length;
    if ((thisRenderedStatuses.length === 0 || currentStatuses.length < statuses.length) && statuses.length >= 20 && tryCount <= 3) {
        await loadTimelineForInstance(domain, access, apiURL, ++tryCount);
    }

    if (currentStatuses.length === 0) {
        document.getElementById("feed-items").innerHTML = "<h2>No content found for this feed</h2>";
        max_id = null;
    }
}

///======================AI LOGIC=========================

document.getElementById("analyze-feed")?.addEventListener("click", async () => {
    if (!ai && aiEnabled) {
        await initAI();
    }
    if (!ai) {
        alert("AI Features are disabled. Enable them in Settings to use sentiment analysis.");
        return;
    }
    const comments = currentStatuses.map((s) => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(s.content, "text/html");
        return doc.body.textContent || "";
    });
    const topic = prompt("Enter the topic to analyze sentiment for:", "dogs");
    if (!topic) return;
    const res = await analyzeSocialMediaFeed(comments, topic);
});

async function analyzeSocialMediaFeed(feedComments, targetTopic) {
    try {
        // Use progress manager: start with total = feedComments length (best-effort)
        ProgressManager.start(feedComments.length, `Analyzing topic: ${targetTopic}`);

        //FIRST, FILTER OUT NON-ENGLISH COMMENTS
        if (features.detector) {
            const filteredComments = [];
            for (const c of feedComments) {
                const strippedText = stripHashtags(c);
                const language = await ai.languageDetect(strippedText);
                if (navigator.language.includes(language.detectedLanguage)) {
                    filteredComments.push(c);
                }
            }
            feedComments = filteredComments;
        }

        const consensus = await getSentimentConsensus(feedComments, targetTopic);

        if (consensus && consensus.consensus !== "no relevant discussions found") {
            console.log(`Topic: ${consensus.topic}`);
            console.log(`Consensus: ${consensus.consensus} (${consensus.confidence * 100}% confidence)`);
            console.log(`Relevant comments: ${consensus.relevant}/${consensus.originalTotal}`);
            console.log("Sentiment breakdown:", consensus.breakdown);
            console.log("Confidence:", consensus.confidence);
            // Render sentiment dialog
            showSentimentResults(consensus);
            ProgressManager.finish();
            return consensus;
        }

        showDebug("No relevant discussions found for the given topic.");
        ProgressManager.finish();
    } catch (error) {
        ProgressManager.finish();
        console.log("Error analyzing feed:", error);
    }
    return null;
}

/**
 * Render sentiment consensus into the ai-results dialog using the sentiment-template
 * @param {{topic:string, consensus:string, relevant:number, originalTotal:number, confidence:number|string, breakdown:object, explanation:string}} consensus
 */
function showSentimentResults(consensus) {
    const tpl = document.getElementById("sentiment-template");
    const dialog = document.getElementById("ai-results");
    if (!tpl || !dialog) return;

    // clear previous content but preserve close button if present
    const existingClose = dialog.querySelector("#ai-result-close-button");
    dialog.innerHTML = "";
    if (existingClose) dialog.appendChild(existingClose);

    const node = tpl.content.cloneNode(true);
    const topicEl = node.querySelector(".sentiment-topic");
    const consensusEl = node.querySelector(".sentiment-consensus-value");
    const consensusTextEl = node.querySelector(".sentiment-explanation-value");
    const confidenceEl = node.querySelector(".sentiment-confidence");
    const positiveSeg = node.querySelector(".sentiment-segment.positive");
    const neutralSeg = node.querySelector(".sentiment-segment.neutral");
    const negativeSeg = node.querySelector(".sentiment-segment.negative");
    const unknownSeg = node.querySelector(".sentiment-segment.unknown");
    const positiveCount = node.querySelector(".positive-count strong");
    const neutralCount = node.querySelector(".neutral-count strong");
    const negativeCount = node.querySelector(".negative-count strong");
    const relevantCount = node.querySelector(".relevant-count strong");

    topicEl.textContent = consensus.topic || "";
    consensusTextEl.textContent = consensus.explanation || "";
    consensusEl.textContent = consensus.consensus || "";
    confidenceEl.textContent = consensus.confidence ? `(${(consensus.confidence * 100).toFixed ? (consensus.confidence * 100).toFixed(0) + "%" : consensus.confidence})` : "";

    const breakdown = consensus.breakdown || {};
    const pos = breakdown.positive || 0;
    const neg = breakdown.negative || 0;
    const neu = breakdown.neutral || 0;
    const unk = breakdown.unknown || breakdown.none || 0;

    const total = pos + neg + neu + unk || 1; // avoid divide by zero

    const posPct = Math.round((pos / total) * 100);
    const neuPct = Math.round((neu / total) * 100);
    const negPct = Math.round((neg / total) * 100);
    const unkPct = Math.max(0, 100 - (posPct + neuPct + negPct));

    // set widths
    positiveSeg.style.width = posPct + "%";
    neutralSeg.style.width = neuPct + "%";
    negativeSeg.style.width = negPct + "%";
    unknownSeg.style.width = unkPct + "%";

    // update counts
    positiveCount.textContent = pos;
    neutralCount.textContent = neu + unk;
    negativeCount.textContent = neg;
    relevantCount.textContent = consensus.relevant || 0;

    // append content after the close button (if present) or as only child
    dialog.appendChild(node);

    if (typeof dialog.showModal === "function") {
        dialog.showModal();
    } else {
        dialog.style.display = "block";
    }
}

async function filterRelevantComments(comments, topic) {
    const relevantComments = [];

    for (let i = 0; i < comments.length; i++) {
        const strippedText = stripHashtags(comments[i]);

        // mark progress for relevance checks
        const result = await ai.isRelevantToTopic(strippedText, topic);
        ProgressManager.tick(1);
        if (result && result.isRelevant) {
            relevantComments.push(comments[i]);
        }
    }
    return relevantComments;
}

function stripHashtags(comment) {
    let stripped = comment.replace(/(\s*#\w+)+\s*$/, "");
    return stripped.trim();
}

async function getSentimentConsensus(comments, topic) {
    const relevantComments = await filterRelevantComments(comments, topic);
    if (relevantComments.length === 0) {
        return {
            topic, consensus: "no relevant discussions found", relevant: 0, originalTotal: comments.length,
        };
    }

    const sentiments = [];

    // increase total to account for sentiment analysis steps
    ProgressManager.addTotal(relevantComments.length);
    for (const comment of relevantComments) {
        const sentiment = await ai.analyze(comment, topic); // tick one per analyzed comment
        ProgressManager.tick(1);
        if (sentiment && sentiment.sentiment) {
            sentiments.push(sentiment);
        }
    }

    let summary = ` `;
    for (let i = 0; i < sentiments.length; i++) {
        summary += ` View#${[i + 1]} ${sentiments[i].explanation} \n`;
    }
    const explanation = await ai.summarize(summary);

    // Calculate consensus
    const sentimentCounts = sentiments.reduce((acc, sentiment) => {
        acc[sentiment.sentiment] = (acc[sentiment.sentiment] || 0) + 1;
        return acc;
    }, {});

    const dominant = Object.entries(sentimentCounts).sort(([, a], [, b]) => b - a)[0];

    return {
        topic,
        consensus: dominant[0],
        relevant: relevantComments.length,
        confidence: (dominant[1] / sentiments.length).toFixed(2),
        breakdown: sentimentCounts,
        originalTotal: comments.length,
        explanation: explanation,
    };
}

async function initAI() {
    let kind = document.getElementById("ai-models").value;
    if (kind === "web") {
        kind = features.language ? "web" : "wllama";
    }

    if (kind === "wllama") {
        if (!features.wasm) {
            showDebug("AI features are not supported on this device/browser.");
            return;
        }
    }
    if (features.device === "watch") {
        showDebug("AI features are not supported on this device/browser.");
        return;
    }

    try {
        if (!ai) {
            let size = document.getElementById("ai-size").value;

            if (features.memory <= 4 && size === "large") {
                size = "default";
            }
            if (features.memory <= 2 || features.storage < 10) {
                size = "small";
            }

            ai = new AIHelper(kind, features, size, async (item) => {
                await new Promise((done) => {
                    ai.languageDetect(item.rawText)
                        .then((language) => {
                            item.s.detectedLanguage = language.detectedLanguage;
                            if (!language || language.detectedLanguage === "en" || language.detectedLanguage.startsWith("en")) {
                                item.translateButton.remove();
                            }
                            done();
                        })
                        .catch((err) => {
                            if (features.device === "watch" || features.device === "phone") {
                                showDebug(">>> AI init error: " + err);
                            }
                            console.log(err);
                            done();
                        });
                });
            });
        }
        await ai.init((progress) => {
            if (ProgressManager.total === 0) {
                if (progress.loaded === progress.total) {
                    return;
                }
                ProgressManager.start(progress.total, "Loading AI Model...");
            }
            ProgressManager.setRelative(progress.loaded);
            if (progress.loaded === progress.total) {
                ProgressManager.finish();
            }
        });
    } catch (e) {
        if (features.device === "watch" || features.device === "phone") {
            showDebug(">>> AI init error: " + e);
        }
        if (e.message.includes("equires a user gesture")) {
            aiEnabled = false;
            ai = null;
            document.getElementById("ai-toggle").checked = false;

            await saveSetting("aiEnabled", aiEnabled);
            showDebug("New AI model initializing. Please toggle AI on again in Settings.");
        }
        console.warn("AI init failed", e);
    }
}

//======================SETTINGS & LOADING LOGIC==============================

const ProgressManager = {
    dialog: () => document.getElementById("loading-dialog"),
    bar: () => document.getElementById("analysis-progress"),
    labelEl: () => document.querySelector('label[for="analysis-progress"]'),
    total: 0,
    current: 0,
    indeterminate: false,
    start(total = 0, label = "Working...") {
        this.total = total || 0;
        this.current = 0;
        this.indeterminate = this.total === 0;
        const dialog = this.dialog();
        const bar = this.bar();
        const labelEl = this.labelEl();
        if (labelEl) labelEl.textContent = label;
        if (!bar) return;
        if (this.indeterminate) {
            bar.removeAttribute("value");
            bar.textContent = "";
            bar.setAttribute("aria-busy", "true");
        } else {
            bar.max = 100;
            bar.value = 0;
            bar.textContent = "0%";
            bar.removeAttribute("aria-busy");
        }
        if (dialog) {
            if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.style.display = "block";
        }
    },
    tick(n = 1) {
        if (this.indeterminate) return; // nothing to do
        this.current += n;
        const bar = this.bar();
        if (!bar || !this.total) return;
        const pct = Math.round((this.current / this.total) * 100);
        bar.value = pct;
        bar.textContent = pct + "%";
    },
    setRelative(value) {
        const percentage = Math.round((value / this.total) * 100);
        const bar = this.bar();
        if (!bar) return;
        bar.value = percentage;
        bar.textContent = percentage + "%";
    },
    set(value) {
        const bar = this.bar();
        if (!bar) return;
        bar.value = value;
        bar.textContent = value + "%";
    },
    addTotal(n = 1) {
        // allow increasing total dynamically
        this.total = (this.total || 0) + n;
        if (!this.indeterminate && this.bar()) {
            // no-op visually; ticks will update percent
        }
    },
    finish() {
        const dialog = this.dialog();
        const bar = this.bar();
        if (bar && !this.indeterminate) {
            bar.value = 100;
            bar.textContent = "100%";
        }
        // small delay so user sees 100%
        setTimeout(() => {
            if (dialog) {
                if (typeof dialog.close === "function") dialog.close(); else dialog.style.display = "none";
            }
            // reset
            if (bar) {
                bar.value = 0;
                bar.textContent = "0%";
                bar.removeAttribute("aria-busy");
            }
            const labelEl = this.labelEl();
            if (labelEl) labelEl.textContent = "AI Analysis Progress:";
            this.total = 0;
            this.current = 0;
            this.indeterminate = false;
        }, 250);
    },
};

async function loadSettings() {
    try {
        const aiRec = await db.table("settings").get("aiEnabled");
        aiEnabled = aiRec ? !!aiRec.value : false;

        const nsfwRec = await db.table("settings").get("nsfwEnabled");
        nsfwEnabled = nsfwRec ? !!nsfwRec.value : false;
    } catch (_) {
        aiEnabled = false;
        nsfwEnabled = false;
    }
}

async function saveSetting(key, value) {
    try {
        await db.table("settings").put({key, value});
    } catch (_) {
    }
}

if (document.getElementById("check-cache")) {
    document.getElementById("check-cache").addEventListener("click", async () => {
        await checkStorage();
    });
}

if (document.getElementById("clear-cache")) {
    document.getElementById("clear-cache").addEventListener("click", async () => {
        await removeModels();
    });
}

if (document.getElementById("check-features")) {
    document
        .getElementById("check-features")
        .addEventListener("click", async () => {
            checkFeatures();
        });
}

function checkFeatures() {
    let debug = `Features\n`;

    for (const [key, value] of Object.entries(features)) {
        debug += `${key}: ${value}\n`;
    }

    showDebug(debug);
}

async function removeModels() {
    try {
        const root = await navigator.storage.getDirectory();
        const entries = root.values();

        for await (const entry of entries) {
            if (entry.kind === "directory") {
                await entry.remove({recursive: true});
            }
        }
    } catch (error) {
        console.error("Error listing OPFS contents:", error);
    }
}

///PHONE APIS
function hapticClick() {
    if (features.vibrate) {
        navigator.vibrate(100);
    }
}

//============DEBUG LOGIC==================

// Debug button to preview sentiment UI with sample data
if (document.getElementById("debug-sentiment")) {
    document.getElementById("debug-sentiment").addEventListener("click", () => {
        const sample = {
            topic: "dogs",
            consensus: "positive",
            relevant: 12,
            originalTotal: 20,
            confidence: 0.75,
            breakdown: {positive: 9, neutral: 2, negative: 1, unknown: 0},
        };
        showSentimentResults(sample);
    });
}

function showDebug(text) {
    const dialog = document.getElementById("debug-dialog");
    if (!dialog) return;
    dialog.querySelector("#debug-message").textContent = text || "";
    dialog.showModal();
}

document.getElementById("close-debug-dialog").addEventListener("click", () => {
    document.getElementById("debug-dialog").close();
});

async function checkStorage() {
    const root = await navigator.storage.getDirectory();
    let totalSize = 0;
    const allEntries = [];

    async function processDirectory(dirHandle) {
        for await (const entry of dirHandle.values()) {
            if (entry.kind === "file") {
                const file = await entry.getFile();
                totalSize += file.size;
                allEntries.push({
                    name: entry.name, size: file.size, type: entry.kind,
                });
                console.log(`File: ${entry.name}, Size: ${file.size} bytes`);
            } else if (entry.kind === "directory") {
                console.log(`Directory: ${entry.name}`);
                // Recursively process subdirectories
                await processDirectory(entry);
            }
        }
    }

    await processDirectory(root);

    showDebug(`Total size: (${(totalSize / 1024 / 1024).toFixed(2)} MB) / Total files: ${allEntries.length}`);
}

///================NAVIGATION LOGIC========================
//
// function addToHistory(state, url) {
//
//     const history = navigation.entries();
//     if (history.length > 1) {
//         const oldState = history[history.length - 1].getState();
//
//         if (oldState) {
//             const firstKey = Object.keys(oldState)[0];
//             if (firstKey) {
//                 if (firstKey == "showToot" || firstKey == "state" || firstKey == "showAccounts" || firstKey == "showHashtags") {
//                     return
//                 }
//             }
//         }
//     }
//
//     if (state.showToot !== true) {
//         state.showToot = false
//     }
//     if (state.showAccounts) {
//         state.showFollowers = false;
//         state.showHashtags = false;
//     }
//     if (state.showFollowers) {
//         state.showAccounts = false;
//         state.showHashtags = false;
//     }
//     if (state.showHashtags) {
//         state.showAccounts = false;
//         state.showFollowers = false;
//     }
//     navigation.navigate(url, {
//         state: state, history: "push",
//     });
// }

function initNavigation() {
    // BACK BUTTON HANDLING
    navigation.addEventListener("navigate", (event) => {
        // event.preventDefault();

        let state = event.destination.getState();

        if (!state) {
            const history = navigation.entries();
            if (history.length > 0) {
                state = history[history.length - 1].getState();
                const firstKey = Object.keys(state)[0];
                if (firstKey) {
                    state[firstKey] = false;
                }
            }
        }

        if (state.showToot === false) {
            closeToot();
        }

        if (state.showAccounts === false) {
            document.getElementById("nav-accounts-section").hidePopover();
        }
        if (state.showFollowers === false) {
            document.getElementById("nav-followers-section").hidePopover();
        }
        if (state.showHashtags === false) {
            document.getElementById("nav-hashtags-section").hidePopover();
        }
    });
}

// -------------------- WebRTC signaling (polling-based) --------------------
const webrtcSignal = {
    pc: null, dc: null, code: null, name: null, ip: null, polling: false, pollHandle: null, pendingCandidates: [],
};

async function webrtcJoin(code, name, ip) {
    webrtcSignal.code = code;
    webrtcSignal.name = name;
    webrtcSignal.ip = ip || null;
    try {
        await fetch("/webrtc/join", {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({code, name, ip}),
        });
    } catch (e) {
        console.warn("webrtc join failed", e);
    }
    if (!webrtcSignal.polling) startPollingSignals();
}

async function webrtcLeave() {
    if (!webrtcSignal.code || !webrtcSignal.name) return;
    try {
        await fetch("/webrtc/leave", {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({
                code: webrtcSignal.code, name: webrtcSignal.name,
            }),
        });
    } catch (e) {
        /* ignore */
    }
    stopPollingSignals();
    if (webrtcSignal.pc) {
        try {
            webrtcSignal.pc.close();
        } catch (_) {
        }
    }
    webrtcSignal.pc = null;
    webrtcSignal.dc = null;
}

function startPollingSignals(interval = 1500) {
    if (webrtcSignal.polling) return;
    webrtcSignal.polling = true;

    async function pollOnce() {
        if (!webrtcSignal.code || !webrtcSignal.name) return;
        try {
            const q = `/webrtc/poll?code=${encodeURIComponent(webrtcSignal.code)}&name=${encodeURIComponent(webrtcSignal.name)}`;
            const r = await fetch(q);
            if (!r.ok) return;
            const msgs = await r.json();
            for (const m of msgs) handleSignalMessage(m);
        } catch (e) {
            // ignore
        }
    }

    pollOnce();
    webrtcSignal.pollHandle = setInterval(pollOnce, interval);
}

function stopPollingSignals() {
    webrtcSignal.polling = false;
    if (webrtcSignal.pollHandle) {
        clearInterval(webrtcSignal.pollHandle);
        webrtcSignal.pollHandle = null;
    }
}

async function sendSignal(msg) {
    if (!webrtcSignal.code || !webrtcSignal.name) return;
    msg.code = webrtcSignal.code;
    msg.from = webrtcSignal.name;
    try {
        await fetch("/webrtc/signal", {
            method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(msg),
        });
    } catch (e) {
        console.warn("sendSignal failed", e);
    }
}

function createPeerConnection() {
    if (webrtcSignal.pc) return webrtcSignal.pc;
    const config = {iceServers: [{urls: ["stun:stun.l.google.com:19302"]}]};
    const pc = new RTCPeerConnection(config);
    pc.onicecandidate = (ev) => {
        if (ev.candidate) {
            sendSignal({type: "ice", data: ev.candidate});
        }
    };
    pc.ondatachannel = (ev) => {
        webrtcSignal.dc = ev.channel;
        webrtcSignal.dc.onmessage = (e) => console.log("webrtc data:", e.data);
        webrtcSignal.dc.onopen = () => console.log("datachannel open");
    };
    webrtcSignal.pc = pc;
    return pc;
}

async function startCall(code, name, ip) {
    await webrtcJoin(code, name, ip);
    const pc = createPeerConnection();
    const dc = pc.createDataChannel("nebulink");
    webrtcSignal.dc = dc;
    dc.onopen = () => console.log("datachannel open");
    dc.onmessage = (e) => console.log("webrtc data:", e.data);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendSignal({to: "", type: "offer", data: offer});
}

async function joinCall(code, name, ip) {
    await webrtcJoin(code, name, ip);
    // poll will deliver any existing offers; when offer arrives handleSignalMessage will create PC and answer
}

async function handleSignalMessage(msg) {
    try {
        if (msg.type === "offer") {
            // incoming offer: create pc, setRemote, create answer
            const pc = createPeerConnection();
            const desc = msg.data;
            await pc.setRemoteDescription(new RTCSessionDescription(desc));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await flushPendingCandidates();
            await sendSignal({to: msg.from, type: "answer", data: answer});
        } else if (msg.type === "answer") {
            if (!webrtcSignal.pc) return;
            await webrtcSignal.pc.setRemoteDescription(new RTCSessionDescription(msg.data));
            await flushPendingCandidates();
        } else if (msg.type === "ice") {
            if (!webrtcSignal.pc) {
                // store candidate until pc exists
                webrtcSignal.pendingCandidates.push(msg.data);
            } else {
                try {
                    await webrtcSignal.pc.addIceCandidate(new RTCIceCandidate(msg.data));
                } catch (e) {
                    console.warn("addIceCandidate failed", e);
                }
            }
        }
    } catch (e) {
        console.error("handleSignalMessage error", e);
    }
}

// After PC is created and remote/locals set, flush pending candidates
async function flushPendingCandidates() {
    if (!webrtcSignal.pc) return;
    for (const c of webrtcSignal.pendingCandidates) {
        try {
            await webrtcSignal.pc.addIceCandidate(c);
        } catch (_) {
        }
    }
    webrtcSignal.pendingCandidates = [];
}


async function translateOther(text, sourceLang, targetLang) {
    return await new Promise((done) => {
        if (!text || text.trim() === "") {
            showDebug("No text to translate.");
            return;
        }

        const body = {
            text: text, targetLanguage: targetLang || "en", sourceLanguage: sourceLang || "auto",
        };

        fetch("/apiTranslate", {
            method: "POST", headers: {
                "Content-Type": "application/json",
            }, body: JSON.stringify(body),
        })
            .then((response) => response.json())
            .then((data) => {
                if (!data.success) {
                    showDebug("Translation failed: " + data.message);
                    return;
                }

                done(data.translated);
            })
            .catch((error) => {
                console.error("Error:", error);
                done(null);
            });
    });
}

function addToCommentsQueue(domain, status, access, callback) {
    commentsQueue.push({domain, status, access, callback});
    if (!processingComments) {
        processQueue();
    }
}

async function processQueue() {
    if (commentsQueue.length === 0) {
        processingComments = false;
        return;
    }

    processingComments = true;
    const item = commentsQueue.shift();
    try {
        await getComments(item.domain, item.status, item.access).then(async (comments) => {
            await item.callback(comments, item.status);
        });
    } catch (e) {
        console.warn("processQueue error", e);
    }
    // process next item
    setTimeout(() => {
        processQueue();
    }, 100); // small delay to avoid blocking
}


///=====================XR LOGIC=================================

function initXR() {

    const canvas = document.getElementById("renderCanvas");
    const engine = new BABYLON.Engine(canvas, true);
    let enterVRButton = document.getElementById("enterVRButton");
    let scene
    let cylinderPanel = null;
    let manager = null;
    let currentPanelData = null
    let camera
    let helloButton3D = null;
    let helloMessagePanel = null;
    let currentMaximizedCardData = null;

    const createScene = async () => {
        scene = new BABYLON.Scene(engine);
        scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);

        manager = new BABYLON.GUI.GUI3DManager(scene);

        // Camera - start outside the cylinder looking in
        camera = new BABYLON.FreeCamera("camera", new BABYLON.Vector3(0, 1.6, -8), scene);
        camera.setTarget(new BABYLON.Vector3(0, 1.6, 0));
        camera.attachControl(canvas, true);
        camera.wheelDeltaPercentage = 0.01;

        // Lighting
        const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
        light.intensity = 1;

        // Create starfield skybox
        const skybox = BABYLON.MeshBuilder.CreateBox("skyBox", {size: 1000.0}, scene);
        const skyboxMaterial = new BABYLON.StandardMaterial("skyBox", scene);
        skyboxMaterial.backFaceCulling = false;
        skyboxMaterial.disableLighting = true;
        skybox.material = skyboxMaterial;
        skybox.infiniteDistance = true;
        skyboxMaterial.diffuseColor = new BABYLON.Color3(0, 0, 0);
        skyboxMaterial.specularColor = new BABYLON.Color3(0, 0, 0);
        skyboxMaterial.emissiveColor = new BABYLON.Color3(0.05, 0.05, 0.1);

        // Create stars using particle system
        const starfield = new BABYLON.PointsCloudSystem("stars", 2, scene);
        starfield.addPoints(3000, (particle, i) => {
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            const radius = 400 + Math.random() * 100;

            particle.position = new BABYLON.Vector3(radius * Math.sin(phi) * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi));

            particle.color = new BABYLON.Color4(0.8 + Math.random() * 0.2, 0.8 + Math.random() * 0.2, 0.9 + Math.random() * 0.1, 1);
        });

        await starfield.buildMeshAsync();
        const starMaterial = new BABYLON.StandardMaterial("starMat", scene);
        starMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
        starMaterial.disableLighting = true;
        starMaterial.pointsCloud = true;
        starMaterial.pointSize = 3;
        starfield.mesh.material = starMaterial;

        // WebXR setup
        const xrHelper = await scene.createDefaultXRExperienceAsync({
            disableDefaultUI: true, uiOptions: {
                sessionMode: "immersive-vr"
            }
        });

        // Hide default VR button
        if (xrHelper.baseExperience.enterExitUI) {
            xrHelper.baseExperience.enterExitUI.overlay.style.display = "none";
        }


        if (enterVRButton) {
            enterVRButton.addEventListener("click", async () => {
                if (xrHelper.baseExperience.state === BABYLON.WebXRState.IN_XR) {
                    await xrHelper.baseExperience.exitXRAsync();
                } else if (xrHelper.baseExperience.state === BABYLON.WebXRState.NOT_IN_XR) {
                    await xrHelper.baseExperience.enterXRAsync("immersive-vr", "local-floor");
                }
            })
        }

        // --- START MODIFICATION ---
        // Create Enter/Exit XR Button
        const exitButton = new BABYLON.GUI.Button3D("exitButton");
        manager.addControl(exitButton);
        exitButton.linkToTransformNode(camera);
        // Position: X=Right, Y=Up, Z=In-Front
        exitButton.position = new BABYLON.Vector3(0.9, .2, 2);
        exitButton.scaling = new BABYLON.Vector3(0.3, 0.1, 0.1);
        exitButton.isVisible = true; // Always visible

        const exitText = new BABYLON.GUI.TextBlock();
        exitText.text = "Enter XR"; // Initial text
        exitText.color = "white";
        exitText.fontSize = 50;
        exitButton.content = exitText;


        exitButton.onPointerUpObservable.add(async () => {
            if (xrHelper.baseExperience.state === BABYLON.WebXRState.IN_XR) {
                await xrHelper.baseExperience.exitXRAsync();
            } else if (xrHelper.baseExperience.state === BABYLON.WebXRState.NOT_IN_XR) {
                await xrHelper.baseExperience.enterXRAsync("immersive-vr", "local-floor");
            }
        });

        // Create Global "Hello" Button
        helloButton3D = new BABYLON.GUI.Button3D("helloButton");
        manager.addControl(helloButton3D);
        helloButton3D.linkToTransformNode(camera);
        // Position: Top Right, just below the Exit button

        helloButton3D.position = new BABYLON.Vector3(0.9, 0.05, 2);
        helloButton3D.scaling = new BABYLON.Vector3(0.3, 0.1, 0.1); // Slightly larger
        helloButton3D.isVisible = false; // Hidden by default

        // Style the "Hello" button
        const helloButtonRect = new BABYLON.GUI.Rectangle();
        helloButtonRect.width = 1;
        helloButtonRect.height = 1;
        helloButtonRect.thickness = 0;
        helloButtonRect.background = "rgba(57,57,57,0.75)"; // Green
        helloButtonRect.cornerRadius = 20;

        const helloButtonText = new BABYLON.GUI.TextBlock();
        helloButtonText.name = "helloButtonText";
        helloButtonText.text = "Summarize";
        helloButtonText.color = "white";
        helloButtonText.fontSize = 50;

        helloButtonRect.addControl(helloButtonText);
        helloButton3D.content = helloButtonRect;

        // Create the "Hello" Message Panel (hidden by default)
        helloMessagePanel = new BABYLON.GUI.Button3D("helloMessagePanel");
        manager.addControl(helloMessagePanel);

        helloMessagePanel.scaling = new BABYLON.Vector3(5, 3, 0.1);
        helloMessagePanel.isVisible = false;

        // Style the message panel
        const messageRect = new BABYLON.GUI.Rectangle();
        messageRect.width = 1;
        messageRect.height = 1;
        messageRect.thickness = 0;
        messageRect.background = "#2a2a4a"; // Dark blue/purple
        messageRect.cornerRadius = 20;

        // 2. Use a Grid for layout (Header + Content)
        const messageGrid = new BABYLON.GUI.Grid();
        messageGrid.width = "50%";
        messageGrid.height = "50%";
        messageGrid.addRowDefinition(25, true); // 80px fixed height for header
        messageGrid.addRowDefinition(1, false); // 1.0 (remainder) for content
        messageRect.addControl(messageGrid);

        // 3. Add the Header
        const headerText = new BABYLON.GUI.TextBlock();
        headerText.text = "Summary:";
        headerText.color = "#AAA"; // Muted color
        headerText.fontSize = 20;
        headerText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
        headerText.textVerticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;

        messageGrid.addControl(headerText, 0, 0); // Add to grid row 0

        // 4. Create a ScrollViewer for the main text
        const scrollViewer = new BABYLON.GUI.ScrollViewer();
        scrollViewer.thickness = 0;
        scrollViewer.barColor = "#FFF";
        scrollViewer.barBackground = "transparent";
        messageGrid.addControl(scrollViewer, 1, 0); // Add to grid row 1

        // 5. Create the Message Text Block
        const messageText = new BABYLON.GUI.TextBlock("helloMessageText"); // Give text a name
        messageText.text = "";
        messageText.color = "white";
        messageText.fontSize = 20;
        messageText.textWrapping = true;
        messageText.resizeToFit = true;
        messageText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
        messageText.textVerticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;


        // 6. Add the text to the ScrollViewer
        scrollViewer.addControl(messageText);

        // 7. Set the whole rectangle as the button content
        helloMessagePanel.content = messageRect;

        // Add click handler to HIDE the panel
        helloMessagePanel.onPointerUpObservable.add(() => {
            helloMessagePanel.isVisible = false;
        });

        // "Hello" button click handler
        helloButton3D.onPointerUpObservable.add(async () => {
            if (currentMaximizedCardData) {

                if (helloMessagePanel.isVisible === true) {
                    const buttonText = helloButton3D.content.getDescendants(false, (c) => c.name === "helloButtonText")[0];
                    if (buttonText) {
                        buttonText.text = "Summarize";
                    }
                    helloMessagePanel.isVisible = false;
                    return
                }

                const textBlock = helloMessagePanel.content.getDescendants(false, (c) => c.name === "helloMessageText")[0];

                helloMessagePanel.isVisible = true;

                if (textBlock) {
                    textBlock.text = "Loading summary...";

                    let text = `${currentMaximizedCardData.displayName} Said: ${currentMaximizedCardData.content} \n\n`;
                    if (!ai && aiEnabled) {
                        await initAI();
                    }
                    if (!ai) {
                        textBlock.text = "AI Features are disabled. Enable them in Settings in the 2D view to use summarization.";
                        return;
                    }

                    let summary = await ai.summarize(text);
                    if (!summary) {
                        summary = "No summary content available."
                    }

                    textBlock.text = summary;
                }

                helloMessagePanel.position = new BABYLON.Vector3(0, 0.5, 1.8); // Adjusted Y

                const buttonText = helloButton3D.content.getDescendants(false, (c) => c.name === "helloButtonText")[0];
                if (buttonText) {
                    buttonText.text = "Close Summary";
                }
            }
        });

        currentPanelData = await createCylinderPanel(scene);

        xrHelper.baseExperience.onStateChangedObservable.add(async (state) => {
            // Always dispose old meshes first
            if (currentPanelData) {
                if (currentPanelData.allPlanes) {
                    currentPanelData.allPlanes.forEach(mesh => mesh.dispose());
                }
                if (currentPanelData.allButtons) {
                    currentPanelData.allButtons.forEach(btn => btn.dispose());
                }
                if (currentPanelData.panel) {
                    currentPanelData.panel.dispose();
                }
                currentPanelData = null;
            }


            // --- MODIFICATION: Update button text ---
            if (state === BABYLON.WebXRState.IN_XR) {
                exitText.text = "Exit XR";
                // Recreate for XR
                currentPanelData = await createCylinderPanel(scene);
            } else if (state === BABYLON.WebXRState.NOT_IN_XR) {
                exitText.text = "Enter XR";
                // Recreate for desktop
                currentPanelData = await createCylinderPanel(scene);
            }
        });
        return scene;
    };

    let isCardMaximized = false;
    let maximizedCard = null;
    let originalCardStates = new Map();
    const maximizeCard = (selectedPlane, allPlanes, panel) => {
        if (isCardMaximized) return;

        isCardMaximized = true;
        maximizedCard = selectedPlane;

        // --- MODIFICATION ---
        helloButton3D.isVisible = true; // Show the global hello button
        currentMaximizedCardData = selectedPlane._cardData; // Store card data
        const selectedNode = selectedPlane._meshButton.node;
        // ---

        // Show full content when maximized
        if (selectedPlane._contentText && selectedPlane._fullContent) {
            selectedPlane._contentText.text = selectedPlane._fullContent;
        }

        // Store original states
        allPlanes.forEach(plane => {
            const nodeToStore = plane._meshButton.node;
            originalCardStates.set(plane, {
                position: nodeToStore.position.clone(),
                rotation: nodeToStore.rotation.clone(),
                scaling: nodeToStore.scaling.clone(),
                visibility: plane.visibility,
                parent: plane.parent
            });
        });

        // Animate selected card (the node) to center and enlarge
        BABYLON.Animation.CreateAndStartAnimation('maximize-position', selectedNode, // Animate the node
            'position', 60, 30, selectedNode.position, new BABYLON.Vector3(0, 0, 2), BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);

        BABYLON.Animation.CreateAndStartAnimation('maximize-scale', selectedNode, // Animate the node
            'scaling', 60, 30, selectedNode.scaling, new BABYLON.Vector3(2.5, 2.5, 1), BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);

        BABYLON.Animation.CreateAndStartAnimation('maximize-rotation', selectedNode, // Animate the node
            'rotation', 60, 30, selectedNode.rotation, new BABYLON.Vector3(0, 0, 0), BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);

        // Fade out other cards
        allPlanes.forEach(plane => {
            if (plane !== selectedPlane) {
                // --- MODIFICATION: Remove logic for plane._helloButton3D ---
                // (No code needed here)
                // ---
                BABYLON.Animation.CreateAndStartAnimation('fade-out', plane, 'visibility', 60, 30, plane.visibility, 0, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
            }
        });

    };

    const minimizeCard = (allPlanes, panel) => {
        if (!isCardMaximized) return;


        const buttonText = helloButton3D.content.getDescendants(false, (c) => c.name === "helloButtonText")[0];
        if (buttonText) {
            buttonText.text = "Summarize";
        }

        helloMessagePanel.isVisible = false;

        isCardMaximized = false;


        // --- MODIFICATION ---
        helloButton3D.isVisible = false; // Hide the global hello button
        currentMaximizedCardData = null; // Clear card data
        // ---

        // Restore truncated content when minimizing
        if (maximizedCard && maximizedCard._contentText && maximizedCard._fullContent) {
            const content = maximizedCard._fullContent;
            maximizedCard._contentText.text = content.substring(0, 200) + (content.length > 200 ? "..." : "");
        }

        // Restore all cards to original states
        allPlanes.forEach(plane => {
            const originalState = originalCardStates.get(plane);
            if (!originalState) return;

            const nodeToRestore = plane._meshButton.node;

            // --- MODIFICATION: Remove logic for plane._helloButton3D ---
            // (No code needed here)
            // ---

            // Animate back to original position
            BABYLON.Animation.CreateAndStartAnimation('restore-position', nodeToRestore, // Animate the node
                'position', 60, 30, nodeToRestore.position, originalState.position, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
            // ... (restore-scale and restore-rotation animations for nodeToRestore) ...
            BABYLON.Animation.CreateAndStartAnimation('restore-scale', nodeToRestore, // Animate the node
                'scaling', 60, 30, nodeToRestore.scaling, originalState.scaling, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);

            BABYLON.Animation.CreateAndStartAnimation('restore-rotation', nodeToRestore, // Animate the node
                'rotation', 60, 30, nodeToRestore.rotation, originalState.rotation, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);


            BABYLON.Animation.CreateAndStartAnimation('fade-in', plane, 'visibility', 60, 30, plane.visibility, originalState.visibility, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
        });

        maximizedCard = null;
        originalCardStates.clear();
    };
    const createNativePostCard = (scene, article, index, panel, allPlanes) => {
        // Extract data from article
        const displayName = article.querySelector('.status-display_name')?.textContent || 'Unknown';
        const avatarSrc = article.querySelector('.status-avatar')?.src || "";
        const acct = article.querySelector('.status-acct')?.textContent || '@unknown';
        const date = article.querySelector('.status-date')?.textContent || 'now';
        const content = article.querySelector('.status-content')?.textContent || '';
        const likeCount = article.querySelector('.status-like-count')?.textContent || '0';


        const headerFont = 75
        const textFont = 50
        const smallFont = 35
        const padding = 10


        const faceUV = new Array(6);
        for (let i = 0; i < 6; i++) {
            faceUV[i] = new BABYLON.Vector4(0, 0, 0, 0); // All faces blank by default
        }
        faceUV[1] = new BABYLON.Vector4(0, 0, 1, 1); // Set face 1 (front) to show the full texture

        // Create a rectangular box
        const plane = BABYLON.MeshBuilder.CreateBox(`card-box-${index}`, {
            width: 4, height: 2, depth: 0.05, sideOrientation: BABYLON.Mesh.FRONTSIDE, faceUV: faceUV // <-- ADD THIS LINE
        }, scene);


        // Make sure plane is pickable
        plane.isPickable = true;

        // Add standard material
        const mat = new BABYLON.StandardMaterial(`card-mat-${index}`, scene);
        mat.diffuseColor = new BABYLON.Color3(0.1, 0.1, 0.1);
        mat.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
        mat.backFaceCulling = true;
        plane.material = mat;

        // Create AdvancedDynamicTexture with matching aspect ratio (4:2 = 2:1)
        const advancedTexture = BABYLON.GUI.AdvancedDynamicTexture.CreateForMesh(plane, 2048,  // width resolution (2:1 ratio)
            1024,  // height resolution
            false);

        // Store the texture reference on the plane for later access
        plane._advancedTexture = advancedTexture;

        // Main container with rounded corners
        const cardRect = new BABYLON.GUI.Rectangle();
        cardRect.width = "95%";
        cardRect.height = "95%";
        cardRect.thickness = 0;
        cardRect.background = "#1a1a1a";
        cardRect.cornerRadius = 20;
        advancedTexture.addControl(cardRect);

        // Content container - use Grid for better layout control
        const grid = new BABYLON.GUI.Grid();
        grid.width = "90%";
        grid.height = "90%";

        // Define rows: header, content, footer

        const hh = headerFont + textFont + padding
        grid.addRowDefinition(hh, true);  // Header (pixels)
        grid.addRowDefinition(1, false);  // Content (proportional)
        grid.addRowDefinition(60, true);  // Footer (pixels)
        // ---

        // Define columns for left content and right metadata
        grid.addColumnDefinition(0.7, false);  // Main content (70%)
        grid.addColumnDefinition(0.3, false);  // Metadata (30%)

        cardRect.addControl(grid);

        // Header section (spans both columns)
        const headerContainer = new BABYLON.GUI.Rectangle();
        headerContainer.thickness = 0;
        headerContainer.background = "transparent";
        grid.addControl(headerContainer, 0, 0);
        grid.addControl(headerContainer, 0, 1);

        // Use a nested grid for Avatar | Name/Acct
        const headerGrid = new BABYLON.GUI.Grid();
        headerGrid.width = "100%";
        headerGrid.height = "100%";
        headerGrid.addColumnDefinition(100, true); // 100px for avatar
        headerGrid.addColumnDefinition(1, false);  // Remainder for text
        headerContainer.addControl(headerGrid);

        // 1. Avatar
        if (avatarSrc) {
            // Use an Ellipse for a circular frame
            const avatarFrame = new BABYLON.GUI.Ellipse();
            avatarFrame.width = `${headerFont}px`;
            avatarFrame.height = `${headerFont}px`;
            avatarFrame.thickness = 0;
            avatarFrame.paddingLeft = "10px";
            avatarFrame.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;

            const avatarImg = new BABYLON.GUI.Image("avatar", avatarSrc);
            avatarImg.stretch = BABYLON.GUI.Image.STRETCH_UNIFORM;

            avatarFrame.addControl(avatarImg); // Ellipse will clip the image
            headerGrid.addControl(avatarFrame, 0, 0); // Row 0, Col 0
        }

        // 2. Name/Acct StackPanel
        const nameStack = new BABYLON.GUI.StackPanel();
        nameStack.width = "100%";
        nameStack.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
        nameStack.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_CENTER;
        headerGrid.addControl(nameStack, 0, 1); // Row 0, Col 1

        // Display name in header
        const nameText = new BABYLON.GUI.TextBlock();
        nameText.text = displayName;
        nameText.height = `${headerFont}px`;
        nameText.fontSize = headerFont;
        nameText.color = "white";
        nameText.fontWeight = "bold";
        nameText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
        nameText.paddingLeft = "10px"; // Give it space from the avatar
        nameStack.addControl(nameText);

        // Account handle in header
        const acctText = new BABYLON.GUI.TextBlock();
        acctText.text = acct;
        acctText.height = `${textFont}px`;
        acctText.fontSize = textFont;
        acctText.color = "#888";
        acctText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
        acctText.paddingLeft = "10px"; // Give it space from the avatar
        nameStack.addControl(acctText);

        // Main content area (left column) - use ScrollViewer for long text
        const scrollViewer = new BABYLON.GUI.ScrollViewer();
        scrollViewer.thickness = 0;
        scrollViewer.barColor = "#666";
        scrollViewer.barBackground = "#222";
        scrollViewer.thumbLength = 0.3;
        grid.addControl(scrollViewer, 1, 0);

        plane._scrollViewer = scrollViewer;
        // Content text inside scroll viewer
        const contentText = new BABYLON.GUI.TextBlock();
        contentText.text = content.substring(0, 200) + (content.length > 200 ? "..." : ""); // Truncated initially
        contentText.fontSize = textFont;
        contentText.color = "#ddd";
        contentText.textWrapping = true;
        contentText.textVerticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
        contentText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
        // contentText.paddingTop = "20px";
        contentText.paddingLeft = "20px";
        // contentText.paddingRight = "20px";
        // contentText.paddingBottom = "20px";
        contentText.resizeToFit = true;
        scrollViewer.addControl(contentText);

        // Store reference to content text for updating when maximized
        plane._contentText = contentText;
        plane._fullContent = content;

        // Metadata area (right column)
        const metadataStack = new BABYLON.GUI.StackPanel();
        // metadataStack.paddingTop = "20px";
        // metadataStack.paddingRight = "20px";
        grid.addControl(metadataStack, 1, 1);

        const dateText = new BABYLON.GUI.TextBlock();
        dateText.text = date;
        dateText.height = "30px";
        dateText.fontSize = smallFont;
        dateText.color = "#666";
        dateText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT;
        metadataStack.addControl(dateText);

        // Footer (spans both columns)
        const footerContainer = new BABYLON.GUI.Rectangle();
        footerContainer.thickness = 0;
        footerContainer.background = "transparent";
        grid.addControl(footerContainer, 2, 0);

        const likeText = new BABYLON.GUI.TextBlock();
        likeText.text = `♥ ${likeCount}`;
        likeText.fontSize = textFont;
        likeText.color = "#888";
        likeText.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
        likeText.paddingLeft = "20px";
        footerContainer.addControl(likeText);


        // Store reference for later use
        plane._cardData = {displayName, acct, date, content, likeCount};

        return plane;
    };
    const createCylinderPanel = async (scene) => {
        const panel = new BABYLON.GUI.CylinderPanel();
        panel.radius = 10
        panel.margin = 0.3;
        panel.position = new BABYLON.Vector3(0, 1.6, -4);

        manager.addControl(panel);

        const feedContainer = document.getElementById('feed-items');
        const articles = feedContainer.querySelectorAll('article');

        panel.blockLayout = true;

        const allPlanes = [];
        const allButtons = [];

        articles.forEach((article, index) => {
            const cardPlane = createNativePostCard(scene, article, index, panel, allPlanes);
            allPlanes.push(cardPlane);

            // --- MODIFICATION: Removed all helloButton3D code ---

            // Wrap in MeshButton3D for panel compatibility
            const meshButton = new BABYLON.GUI.MeshButton3D(cardPlane, `mesh-btn-${index}`);

            // Store reference to the mesh button on the plane
            cardPlane._meshButton = meshButton;

            // Use the MeshButton3D's click handler
            meshButton.onPointerUpObservable.add((eventData, eventState) => {
                console.log(`Clicked card ${index}`);
                if (!isCardMaximized) {
                    maximizeCard(cardPlane, allPlanes, panel);
                } else {
                    minimizeCard(allPlanes, panel);
                }
            });

            // (Hover effects removed for brevity)

            // Add the meshButton to allButtons for disposal
            allButtons.push(meshButton);
            panel.addControl(meshButton);
        });

        panel.blockLayout = false;
        cylinderPanel = panel;

        // Return references for later use
        return {panel, allPlanes, allButtons};
    };

    createScene().then(scene => {
        engine.runRenderLoop(() => {
            scene.render();
        });
    });

    window.addEventListener("resize", () => {
        engine.resize();
    });
}