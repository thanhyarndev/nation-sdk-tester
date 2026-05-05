# NWRFID Web Serial SDK

A lightweight, event-driven JavaScript SDK (abstraction layer) designed to communicate with a 3-antenna RFID reader directly from the browser using the **Web Serial API**.

## Overview

This SDK is intended to be a clean, modern ES6 framework providing a modular pipeline for managing serial connection, configuring reader hardware, and processing high-frequency tag data smoothly without blocking the main browser thread.

### Key Features
- **Browser-Native**: No desktop services required. Connects via `navigator.serial`.
- **Event-Driven**: Implements a clean publish/subscribe pattern for tags, errors, and connection state.
- **Data Pipeline**: Raw binary frames pass through an extensible multi-stage pipeline: `Access Filter -> Signal Filter -> Validation -> Stability -> Application`.
- **Abstracted Configuration**: Set hardware detection levels (1-7) instead of manually pushing raw Hex configurations.

---

## Installation

As an ES6 module, you can directly import it into your front-end project. No `npm install` is required if using native browser modules.

```javascript
import { NWRFID } from './nw-rfid.js';
```

---

## API Documentation

### Connection Management
* `connect()` : `Promise<void>` — Requests port access (prompts user), opens the serial connection, and begins the non-blocking read loop.
* `disconnect()` : `Promise<void>` — Cancels the data stream and releases the serial port.

### Configuration
* `setDetectionLevel(level: number)` — Sets a mapped hardware profile (Power, Thresholds). Expects an integer from `1` (lowest) to `7` (highest).
* `setPresenceStabilityTime(ms: number)` — Prevents ghost reads. Sets the time a tag must be consistently polled before triggering a `tag` event.
* `setAccessFilter(prefix: string)` — Sets an EPC prefix to ignore non-matching tags at the beginning of the pipeline.

### Inventory Control
* `startInventory()` : `Promise<void>` — Dispatches the hex payload to begin Session 0 reading.
* `stopInventory()` : `Promise<void>` — Dispatches the hex payload to stop the reader.

### Event System
Available Events: `'tag'`, `'connect'`, `'disconnect'`, `'error'`
* `on(eventName: string, callback: Function)` — Subscribe to an event.
* `off(eventName: string, callback: Function)` — Unsubscribe from an event.

---

## Example Usage

See `example.js` for a full working implementation.

```javascript
import { NWRFID } from './nw-rfid.js';

const rfid = new NWRFID();

// Listen to tag events
rfid.on('tag', (tag) => {
  console.log(`Detected Tag: ${tag.epc} on Antenna ${tag.antenna} (RSSI: ${tag.rssi})`);
});

// Setup must be triggered by a user action (e.g., clicking a button)
document.getElementById('connectBtn').addEventListener('click', async () => {
  try {
    await rfid.connect();
    
    rfid.setDetectionLevel(3);
    rfid.setAccessFilter('E200');
    
    await rfid.startInventory();
  } catch (err) {
    console.error('Connection failed:', err);
  }
});
```

---

## Notes on Web Serial API Support

The Web Serial API is a modern browser feature. 
- **Supported Browsers**: Google Chrome (desktop & Android), Microsoft Edge, Opera.
- **Unsupported**: Mozilla Firefox, Apple Safari (iOS/macOS).
- **Requirements**: Due to security constraints, the Web Serial API requires a **Secure Context** (`HTTPS` or `localhost`), and the initial connection prompt (`requestPort()`) **must** be triggered by an explicit user gesture (such as a `click` or `touchend` event).
