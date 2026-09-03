// Shared UptimeRobot v3 API client and monitor helpers.
//
// This module is imported by both extension.js (running inside GNOME Shell)
// and prefs.js (running in a separate GTK process), so it must only depend on
// libraries that are available in both: Gio, GLib and Soup. Never import
// Clutter, St or anything from resource:///org/gnome/shell/ here.
//
// API reference: https://uptimerobot.com/api/v3/

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
// Pin libsoup 3: GNOME Shell only allows Soup 3, and the preferences process
// must not accidentally pick up Soup 2.4 where both typelibs are installed.
import Soup from 'gi://Soup?version=3.0';

export const API_BASE_URL = 'https://api.uptimerobot.com/v3';
export const DASHBOARD_URL = 'https://dashboard.uptimerobot.com';

// GET /monitors returns at most 200 monitors per page (default 50).
export const PAGE_SIZE = 200;
// Safety net against a broken `nextLink` chain: never follow more pages
// than this (200 monitors × 25 pages = 5000 monitors).
const MAX_PAGES = 25;

// Monitor status values of the UptimeRobot v3 API. The API documents
// PAUSED, STARTED, UP, LOOKS_DOWN and DOWN; SEEMS_DOWN and NOT_CHECKED_YET
// are accepted as well because some clients still see them.
export const MonitorStatus = {
    PAUSED: 'PAUSED',
    STARTED: 'STARTED',
    NOT_CHECKED_YET: 'NOT_CHECKED_YET',
    UP: 'UP',
    LOOKS_DOWN: 'LOOKS_DOWN',
    SEEMS_DOWN: 'SEEMS_DOWN',
    DOWN: 'DOWN',
};

export const Health = {
    UNKNOWN: 'unknown',
    OK: 'ok',
    DOWN: 'down',
};

/**
 * Normalise a status value as returned by the API to upper case so that
 * comparisons are case-insensitive.
 *
 * @param {object} monitor a monitor object of the v3 API
 * @returns {string} the upper-cased status, '' when missing
 */
export function monitorStatus(monitor) {
    return String(monitor?.status ?? '').toUpperCase();
}

/**
 * @param {object} monitor a monitor object of the v3 API
 * @returns {boolean} whether the monitor is paused
 */
export function isPaused(monitor) {
    return monitorStatus(monitor) === MonitorStatus.PAUSED;
}

/**
 * Map a monitor to the health shown in the UI.
 *
 * DOWN, LOOKS_DOWN and SEEMS_DOWN are "down"; UP is "ok"; everything else
 * (paused, started, not checked yet, unknown values) is "unknown".
 *
 * @param {object} monitor a monitor object of the v3 API
 * @returns {string} one of the Health values
 */
export function monitorHealth(monitor) {
    switch (monitorStatus(monitor)) {
    case MonitorStatus.DOWN:
    case MonitorStatus.LOOKS_DOWN:
    case MonitorStatus.SEEMS_DOWN:
        return Health.DOWN;
    case MonitorStatus.UP:
        return Health.OK;
    default:
        return Health.UNKNOWN;
    }
}

/**
 * Monitor IDs are numbers in the API but are stored as strings in the
 * `hidden-monitors` setting (GSettings string arrays are the simplest
 * portable container).
 *
 * @param {object} monitor a monitor object of the v3 API
 * @returns {string} the monitor ID as a string
 */
export function monitorKey(monitor) {
    return String(monitor.id);
}

/**
 * Human readable name of a monitor.
 *
 * @param {object} monitor a monitor object of the v3 API
 * @returns {string} the friendly name, falling back to the URL or the ID
 */
export function monitorName(monitor) {
    return monitor.friendlyName || monitor.url || `#${monitor.id}`;
}

/**
 * URL of the monitor's page in the UptimeRobot dashboard.
 *
 * @param {object} monitor a monitor object of the v3 API
 * @returns {string} dashboard URL
 */
export function monitorDashboardUrl(monitor) {
    return `${DASHBOARD_URL}/monitors/${encodeURIComponent(monitor.id)}`;
}

/**
 * The link to open when the user clicks a monitor.
 *
 * HTTP(S) and keyword monitors carry the monitored page in `url`; that page
 * is opened directly. Ping, port and DNS monitors only carry a host name or
 * IP address there, which is not something a browser can open in a useful
 * way, so for those the monitor's dashboard page is used instead.
 *
 * @param {object} monitor a monitor object of the v3 API
 * @returns {{uri: string, isDashboard: boolean}} the link and whether it
 *   points to the UptimeRobot dashboard rather than the monitored site
 */
export function monitorLink(monitor) {
    const url = String(monitor.url ?? '').trim();
    if (/^https?:\/\//i.test(url))
        return {uri: url, isDashboard: false};
    return {uri: monitorDashboardUrl(monitor), isDashboard: true};
}

/**
 * Error thrown for unsuccessful API calls. `status` holds the HTTP status
 * code (0 when the request did not get a response).
 */
export class ApiError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

/**
 * Minimal client for the UptimeRobot v3 REST API.
 *
 * Authentication uses the API key as a bearer token. Pagination is
 * cursor-based: every page carries a `nextLink` (a full URL, or null on the
 * last page) that is followed until all monitors have been collected.
 */
export class UptimeRobotClient {
    /**
     * @param {string} userAgent User-Agent header sent with every request
     */
    constructor(userAgent = 'uptimerobot-gnome-extension') {
        this._session = new Soup.Session({
            timeout: 30,
            user_agent: userAgent,
        });
    }

    /** Abort all in-flight requests and release the HTTP session. */
    destroy() {
        this._session?.abort();
        this._session = null;
    }

    /**
     * Fetch every monitor of the account, following pagination.
     *
     * @param {string} apiKey UptimeRobot API key (main or read-only)
     * @param {Gio.Cancellable} [cancellable] cancels the requests
     * @returns {Promise<object[]>} all monitors as returned by the API
     */
    async fetchMonitors(apiKey, cancellable = null) {
        const monitors = [];
        let uri = `${API_BASE_URL}/monitors?limit=${PAGE_SIZE}`;
        for (let page = 0; uri && page < MAX_PAGES; page++) {
            const response = await this._get(apiKey, uri, cancellable);
            const data = Array.isArray(response.data) ? response.data : [];
            monitors.push(...data);

            const next = response.nextLink;
            // Only follow links that stay on the API host; a relative link
            // is resolved against the API base URL.
            if (typeof next !== 'string' || next === '' || data.length === 0)
                break;
            uri = next.startsWith('/') ? `${API_BASE_URL}${next}` : next;
            if (!uri.startsWith(API_BASE_URL))
                break;
        }
        return monitors;
    }

    /**
     * Perform one authenticated GET request and parse the JSON body.
     *
     * @param {string} apiKey bearer token
     * @param {string} uri absolute URL to request
     * @param {Gio.Cancellable} [cancellable] cancels the request
     * @returns {Promise<object>} parsed JSON response
     */
    _get(apiKey, uri, cancellable) {
        return new Promise((resolve, reject) => {
            if (!this._session) {
                reject(new ApiError('client destroyed'));
                return;
            }

            const message = Soup.Message.new('GET', uri);
            if (!message) {
                reject(new ApiError(`invalid URL: ${uri}`));
                return;
            }
            message.request_headers.append('Authorization', `Bearer ${apiKey}`);
            message.request_headers.append('Accept', 'application/json');

            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
                        const status = message.get_status();

                        if (status !== Soup.Status.OK)
                            throw new ApiError(describeHttpError(status, message.get_reason_phrase(), text), status);

                        resolve(JSON.parse(text));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }
}

/**
 * Build a readable error message for a failed HTTP request, preferring the
 * `message` field of the JSON error body the v3 API returns.
 *
 * @param {number} status HTTP status code
 * @param {string|null} reason HTTP reason phrase
 * @param {string} body raw response body
 * @returns {string} error message
 */
function describeHttpError(status, reason, body) {
    switch (status) {
    case Soup.Status.UNAUTHORIZED:
        return 'invalid API key (HTTP 401)';
    case Soup.Status.FORBIDDEN:
        return 'API key lacks permission (HTTP 403)';
    case 429:
        return 'API rate limit exceeded (HTTP 429)';
    }

    let detail = '';
    try {
        const json = JSON.parse(body);
        const message = json?.message ?? json?.error;
        if (Array.isArray(message))
            detail = message.join(', ');
        else if (typeof message === 'string')
            detail = message;
    } catch {
        // not JSON, ignore the body
    }

    const base = `HTTP ${status} ${reason ?? ''}`.trim();
    return detail ? `${base}: ${detail}` : base;
}

/**
 * Whether an error is the result of a cancelled request (e.g. the extension
 * being disabled while a refresh is running).
 *
 * @param {Error} e the error
 * @returns {boolean} true for Gio cancellation errors
 */
export function isCancelledError(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}
