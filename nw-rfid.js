/**
 * NWRFID - A lightweight Web Serial SDK for 3-Antenna RFID Readers
 * 
 * Provides an event-driven architecture and a modular data processing pipeline 
 * for communicating with RFID hardware via the browser.
 */

export class NWRFID {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.keepReading = false;
    this.listeners = new Map();
    this.rxBuffer = new Uint8Array(0);
    this.tagCache = new Map();
    
    // Filter & Stability Config
    this.filtersConfig = {
      prefix: "",
      minCount: 1,
      countWindow: 2000, // ms: timeframe to reach minCount
      minRssi: -100
    };
    this.sleepTime = 5000; // ms: sleep time after detection
    
    // Garbage Collector to prevent memory leaks during long reads
    this.gcInterval = setInterval(() => this._gcTagCache(), 10000);
    
    // Configuration state
    this.config = {
      detectionLevel: 4, // Default level 1-7
      presenceStabilityTime: 1000, // ms required for a tag to be considered stable
      accessFilter: null, // Hex string prefix to filter tags early
    };

    // Tracking state for the stability check stage
    this.tagCache = new Map(); // epc -> { firstSeen, lastSeen, count, rssi }
  }

  // ==========================================
  // 1. Event System (Publish/Subscribe)
  // ==========================================
  
  /**
   * Subscribe to an SDK event.
   * @param {string} eventName - 'tag', 'error', 'connect', 'disconnect'
   * @param {Function} callback - Function to execute when event is emitted
   */
  on(eventName, callback) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName).add(callback);
  }

  /**
   * Unsubscribe from an SDK event.
   * @param {string} eventName - 'tag', 'error', 'connect', 'disconnect'
   * @param {Function} callback - Function to remove
   */
  off(eventName, callback) {
    if (this.listeners.has(eventName)) {
      this.listeners.get(eventName).delete(callback);
    }
  }

  /**
   * Emit an event to all registered subscribers.
   * @param {string} eventName - Name of the event
   * @param {any} payload - Data to pass to callbacks
   */
  emit(eventName, payload) {
    if (this.listeners.has(eventName)) {
      for (const callback of this.listeners.get(eventName)) {
        try {
          callback(payload);
        } catch (err) {
          console.error(`Error in event listener for ${eventName}:`, err);
        }
      }
    }
  }

  // ==========================================
  // 2. Connection Management
  // ==========================================

  /**
   * Opens the browser's port selection dialog, initializes the serial connection, 
   * and starts the continuous read loop.
   * Note: This must be triggered by a user gesture (e.g. click).
   * @returns {Promise<void>}
   */
  async connect() {
    try {
      if (!('serial' in navigator)) {
        throw new Error('Web Serial API is not supported in this browser.');
      }

      // Request a port and open it
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 115200 }); // TODO: Adjust baudRate per hardware specs

      this.emit('connect', { status: 'connected' });
      
      this.keepReading = true;
      
      // Start non-blocking read loop
      this._startReadLoop();
    } catch (error) {
      this.emit('error', { type: 'connection', message: error.message });
      throw error;
    }
  }

  /**
   * Gracefully stops reading and closes the serial port.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.keepReading = false;
    
    if (this.reader) {
      await this.reader.cancel();
      this.reader = null;
    }
    
    if (this.port) {
      await this.port.close();
      this.port = null;
    }
    
    this.emit('disconnect', { status: 'disconnected' });
  }

  /**
   * Internal read loop for continuous data ingestion from the hardware.
   * Designed to run without blocking the main thread.
   */
  async _startReadLoop() {
    while (this.port.readable && this.keepReading) {
      this.reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) {
            // Reader has been canceled
            break;
          }
          if (value) {
            // Process incoming Uint8Array chunk
            this._processRawData(value);
          }
        }
      } catch (error) {
        this.emit('error', { type: 'read', message: error.message });
      } finally {
        this.reader.releaseLock();
      }
    }
  }

  // ==========================================
  // Filter Configs
  // ==========================================
  
  setAccessFilter(prefix) {
    this.filtersConfig.prefix = prefix.toUpperCase().replace(/ /g, '');
    console.log(`[NWRFID] Access Filter set to prefix: '${this.filtersConfig.prefix}'`);
  }
  
  setMinCount(count) {
    this.filtersConfig.minCount = count;
    console.log(`[NWRFID] Min Count Filter set to: ${count}`);
  }
  
  setMinRssi(rssi) {
    this.filtersConfig.minRssi = rssi;
    console.log(`[NWRFID] Min RSSI Filter set to: ${rssi} dBm`);
  }
  
  setStabilityTime(ms) {
    this.setSleepTime(ms); // backward compatibility
  }

  setCountWindow(ms) {
    this.filtersConfig.countWindow = ms;
    console.log(`[NWRFID] Count Window set to: ${ms} ms`);
  }

  setSleepTime(ms) {
    this.sleepTime = ms;
    console.log(`[NWRFID] Sleep Time set to: ${ms} ms`);
  }

  // ==========================================
  // Core Connection API
  // ==========================================

  /**
   * Configures reader power and thresholds based on a predefined 1-7 level scale.
   * @param {number} level - 1 (Lowest) to 7 (Highest)
   */
  async setDetectionLevel(level) {
    if (level < 1 || level > 7) {
      throw new Error('Detection level must be between 1 and 7');
    }
    this.config.detectionLevel = level;

    // LUT for NATION Protocol (Ant1, Ant2, Ant3)
    const levelLUT = {
      1: { a1: 12, a2: 10, a3: 10 },
      2: { a1: 14, a2: 12, a3: 12 },
      3: { a1: 16, a2: 13, a3: 13 }, // Default
      4: { a1: 17, a2: 14, a3: 14 },
      5: { a1: 18, a2: 15, a3: 15 },
      6: { a1: 19, a2: 17, a3: 17 },
      7: { a1: 20, a2: 18, a3: 18 }
    };
    
    const pwr = levelLUT[level];
    
    // Data Format: [PID_Ant1, Val1, PID_Ant2, Val2, PID_Ant3, Val3]
    const data = [
      0x01, pwr.a1, 
      0x02, pwr.a2, 
      0x03, pwr.a3
    ];

    // PCW for CONFIGURE_READER_POWER: 0x00010201 (Category: 0x01, MID: 0x01)
    const command = 0x00010201;

    const frame = this.generateFrame(command, data);
    
    await this._sendCommand(frame);
    console.log(`[NWRFID] Detection level set to ${level} (Ant1:${pwr.a1}, Ant2:${pwr.a2}, Ant3:${pwr.a3})`);
  }

  /**
   * Gets the current power configuration from the reader.
   * Sends the QUERY_READER_POWER (0x0202) command.
   */
  async getPower() {
    // PCW for QUERY_READER_POWER: 0x00010202 (Category: 0x01, MID: 0x02)
    const command = 0x00010202;
    const data = []; // No payload needed
    const frame = this.generateFrame(command, data);
    
    await this._sendCommand(frame);
    console.log('[NWRFID] Queried Reader Power (0x0202)');
  }

  /**
   * Set how long (in ms) a tag must be consistently seen before it's considered "stable"
   * and emitted to the application.
   * @param {number} ms - milliseconds
   */
  setPresenceStabilityTime(ms) {
    this.config.presenceStabilityTime = ms;
  }

  // ==========================================
  // 4. Inventory Control
  // ==========================================

  /**
   * Starts the inventory scanning process (e.g., Session 0 scanning).
   * @returns {Promise<void>}
   */
  async startInventory() {
    // To ensure the reader is not hanging, we ALWAYS send STOP before START
    // just like the reference working system does.
    await this.stopInventory();
    
    // READ_EPC_TAG: Category 0x01, MID 0x10 -> PCW: 0x00010210
    const command = 0x00010210;
    
    // Data: [Antenna Mask 4 bytes] [Mode 1 byte]
    // 0x0F = 0000 1111 (Turns on all 4 antennas)
    // 0x01 = Constant Reading Mode (Continuous)
    const data = [
      0x00, 0x00, 0x00, 0x0F, 
      0x01
    ];
    
    const frame = this.generateFrame(command, data);
    await this._sendCommand(frame);
    console.log('[NWRFID] Sent START_INVENTORY command (Continuous)');
  }

  /**
   * Stops the inventory scanning process.
   * @returns {Promise<void>}
   */
  async stopInventory() {
    // STOP_INVENTORY: Category 0x01, MID 0xFF -> PCW: 0x000102FF
    const command = 0x000102FF;
    const data = []; // No payload needed for stop
    
    const frame = this.generateFrame(command, data);
    await this._sendCommand(frame);
    console.log('[NWRFID] Sent STOP_INVENTORY command');
  }

  // ==========================================
  // 5. Data Processing Pipeline
  // ==========================================

  /**
   * Internal entry point for buffering and extracting protocol frames from raw serial chunks.
   * @param {Uint8Array} chunk 
   */
  _processRawData(chunk) {
    const newBuffer = new Uint8Array(this.rxBuffer.length + chunk.length);
    newBuffer.set(this.rxBuffer);
    newBuffer.set(chunk, this.rxBuffer.length);
    this.rxBuffer = newBuffer;

    while (this.rxBuffer.length > 0) {
      let headerIdx = -1;
      for (let i = 0; i < this.rxBuffer.length; i++) {
        if (this.rxBuffer[i] === 0x5A) {
          headerIdx = i;
          break;
        }
      }

      if (headerIdx === -1) {
        this.rxBuffer = new Uint8Array(0);
        break;
      }

      if (headerIdx > 0) {
        this.rxBuffer = this.rxBuffer.subarray(headerIdx);
      }

      if (this.rxBuffer.length < 9) break;

      const lenHigh = this.rxBuffer[5];
      const lenLow = this.rxBuffer[6];
      const dataLen = (lenHigh << 8) | lenLow;
      const totalFrameLength = 9 + dataLen;

      if (this.rxBuffer.length < totalFrameLength) break;

      const frameBuffer = this.rxBuffer.subarray(0, totalFrameLength);
      this._parseFrame(frameBuffer);

      this.rxBuffer = this.rxBuffer.subarray(totalFrameLength);
    }
  }

  _parseFrame(frameBuffer) {
    const crcReceived = (frameBuffer[frameBuffer.length - 2] << 8) | frameBuffer[frameBuffer.length - 1];
    const crcCalc = this._calculateCRC16(frameBuffer.subarray(1, frameBuffer.length - 2));
    
    if (crcReceived !== crcCalc) {
      console.warn(`[NWRFID] CRC Mismatch! Expected ${crcCalc.toString(16)}, got ${crcReceived.toString(16)}`);
      return;
    }

    const pcw = [frameBuffer[1], frameBuffer[2], frameBuffer[3], frameBuffer[4]];
    const data = frameBuffer.subarray(7, frameBuffer.length - 2);

    if ((pcw[2] === 0x12 || pcw[2] === 0x02) && pcw[3] === 0x00) {
      console.log(`[IN] TAG: ${this._toHexString(frameBuffer)}`);
      this._parseTagData(data);
    } else {
      console.log(`[IN] ACK: ${this._toHexString(frameBuffer)}`);
    }
  }

  _parseTagData(data) {
    if (data.length < 2) return;
    let offset = 0;
    
    const epcLen = (data[offset++] << 8) | data[offset++];
    if (data.length < offset + epcLen + 3) return;
    
    const epcBytes = data.subarray(offset, offset + epcLen);
    const epc = this._toHexString(epcBytes).replace(/ /g, '');
    offset += epcLen;
    
    const pc = (data[offset++] << 8) | data[offset++];
    const antenna = data[offset++];
    
    let rssi = -100;
    let frequency = 0;
    
    while (offset < data.length) {
      const pid = data[offset++];
      if (pid === 0x01) {
        const rssiVal = data[offset++];
        rssi = -100 + (rssiVal * 70 / 255);
      } else if (pid === 0x02) {
        offset += 1;
      } else if (pid === 0x03) {
        const tidLen = (data[offset++] << 8) | data[offset++];
        offset += tidLen;
      } else if (pid === 0x08) {
        const freqVal = (data[offset++] << 24) | (data[offset++] << 16) | (data[offset++] << 8) | data[offset++];
        frequency = freqVal / 1000;
      } else if (pid === 0x09) {
        offset += 1;
      } else {
        break; // Unknown PID, stop parsing optional fields
      }
    }
    
    const tag = {
      type: 'tag',
      epc,
      antenna,
      rssi: Math.round(rssi * 10) / 10,
      frequency
    };
    
    this._pipeline(tag);
  }
  /**
   * Pipeline for validation, caching and stability logic.
   * @param {Object} tag 
   */
  _pipeline(tag) {
    const now = Date.now();
    let cacheData = this.tagCache.get(tag.epc);
    
    // 1. Update Tracking Map with Sliding Window
    if (!cacheData) {
      cacheData = {
        epc: tag.epc,
        lastSeen: now,
        timestamps: [now], // Store array of timestamps for sliding window
        highestRssi: tag.rssi,
        lastReportedTime: 0,
        detectedCount: 0
      };
      this.tagCache.set(tag.epc, cacheData);
    } else {
      cacheData.lastSeen = now;
      cacheData.timestamps.push(now);
      
      // Remove timestamps older than our count window
      const windowStart = now - this.filtersConfig.countWindow;
      while (cacheData.timestamps.length > 0 && cacheData.timestamps[0] < windowStart) {
        cacheData.timestamps.shift();
      }
      
      if (tag.rssi > cacheData.highestRssi) {
        cacheData.highestRssi = tag.rssi;
      }
    }
    
    // Enrich raw tag with active window count for Table 1
    tag.readCount = cacheData.timestamps.length;
    this.emit('tag', tag);

    // 2. Validation Filters
    if (this.filtersConfig.prefix && !tag.epc.startsWith(this.filtersConfig.prefix)) {
      return; // Blocked by prefix
    }
    if (cacheData.timestamps.length < this.filtersConfig.minCount) {
      return; // Blocked by sliding window count
    }
    if (cacheData.highestRssi < this.filtersConfig.minRssi) {
      return; // Blocked by RSSI limit
    }

    // 3. Sleep / Stability Logic (Debounce)
    if (now - cacheData.lastReportedTime >= this.sleepTime) {
      cacheData.lastReportedTime = now;
      cacheData.detectedCount += 1;
      
      const detectedTag = {
        ...tag,
        readCount: cacheData.timestamps.length,
        detectedCount: cacheData.detectedCount,
        highestRssi: cacheData.highestRssi,
        detectedAt: new Date(now)
      };
      
      // Reset window so it has to earn the count again after sleeping
      cacheData.timestamps = [];
      cacheData.highestRssi = -100;
      
      // Emit stable, filtered tag for Table 2
      this.emit('tag_detected', detectedTag);
    }
  }

  /**
   * Cleans up stale tags from cache to free memory.
   */
  _gcTagCache() {
    const now = Date.now();
    for (const [epc, data] of this.tagCache.entries()) {
      // Remove tags not seen in the last 10 seconds
      if (now - data.lastSeen > 10000) {
        this.tagCache.delete(epc);
      }
    }
  }

  // ==========================================
  // Helper Methods
  // ==========================================

  /**
   * Writes raw bytes to the serial port.
   * @param {Uint8Array} data 
   * @returns {Promise<void>}
   */
  async _sendCommand(data) {
    if (!this.port || !this.port.writable) {
      throw new Error('Port not ready or not writable');
    }
    
    console.log(`[OUT] ${this._toHexString(data)}`);
    
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * Generates a complete NATION Protocol frame.
   * Format: [Header: 0x5A] [PCW: 4 bytes] [Length: 2 bytes] [Data: N bytes] [CRC16: 2 bytes]
   * @param {number} pcw - The 4-byte command (e.g., 0x00000201)
   * @param {number[]} data - Array of data bytes
   * @returns {Uint8Array}
   */
  generateFrame(pcw, data) {
    const header = 0x5A;
    const length = data.length;
    
    // Total Frame Length = Header(1) + PCW(4) + Length(2) + Data(N) + CRC(2)
    const frameLength = 1 + 4 + 2 + length + 2;
    const buffer = new Uint8Array(frameLength);
    
    let offset = 0;
    
    // Header
    buffer[offset++] = header;
    
    // PCW (4 bytes, Big Endian)
    buffer[offset++] = (pcw >>> 24) & 0xFF;
    buffer[offset++] = (pcw >>> 16) & 0xFF;
    buffer[offset++] = (pcw >>> 8) & 0xFF;
    buffer[offset++] = pcw & 0xFF;
    
    // Length (2 bytes, Big Endian)
    buffer[offset++] = (length >>> 8) & 0xFF;
    buffer[offset++] = length & 0xFF;
    
    // Data Payload
    for (let i = 0; i < length; i++) {
      buffer[offset++] = data[i] & 0xFF;
    }
    
    // CRC calculation (CRC-16/XMODEM) over everything before the CRC bytes, EXCLUDING the 0x5A header
    const crc = this._calculateCRC16(buffer.subarray(1, offset));
    
    // CRC16 (2 bytes, Big Endian)
    buffer[offset++] = (crc >>> 8) & 0xFF;
    buffer[offset++] = crc & 0xFF;
    
    return buffer;
  }

  /**
   * Calculates CRC-16/XMODEM.
   * Polynomial: 0x1021, Initial value: 0x0000
   * @param {Uint8Array} buffer 
   * @returns {number} 16-bit CRC
   */
  _calculateCRC16(buffer) {
    let crc = 0x0000;
    for (let i = 0; i < buffer.length; i++) {
      crc ^= (buffer[i] << 8);
      for (let j = 0; j < 8; j++) {
        if ((crc & 0x8000) !== 0) {
          crc = ((crc << 1) ^ 0x1021);
        } else {
          crc = (crc << 1);
        }
      }
      crc &= 0xFFFF;
    }
    return crc;
  }

  /**
   * Helper to convert Uint8Array to a readable hex string.
   * @param {Uint8Array} byteArray 
   * @returns {string}
   */
  _toHexString(byteArray) {
    return Array.from(byteArray)
      .map(b => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
  }

  /**
   * Placeholder: Parses the raw serial buffer to extract a standard tag object.
   * @param {Uint8Array} chunk 

   * @returns {Object|null} Extracted tag frame or null if incomplete
   */
  _mockExtractFrame(chunk) {
    // TODO: Handle frame headers, length bytes, payload extraction, and CRC/Checksum
    // Returning mock data for scaffold completeness
    return {
      type: 'tag',
      epc: 'E200001B2233445566778899',
      rssi: -55,
      antenna: 1
    };
  }
}
