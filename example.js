import { NWRFID } from './nw-rfid.js';

async function main() {
  // 1. Instantiate the SDK
  const rfid = new NWRFID();

  // 2. Register Event Listeners
  rfid.on('connect', () => {
    console.log('✅ Reader connected successfully.');
  });

  rfid.on('disconnect', () => {
    console.log('❌ Reader disconnected.');
  });

  rfid.on('error', (err) => {
    console.error('⚠️ RFID Error encountered:', err.message);
  });

  // Main data hook
  rfid.on('tag', (tag) => {
    // This is only triggered AFTER the tag passes:
    // Access Filter -> Signal Filter -> Validation -> Stability Check
    console.log(`🏷️  Stable Tag Detected: ${tag.epc} (Antenna: ${tag.antenna}, RSSI: ${tag.rssi})`);
  });

  // 3. Connect and Configure (Usually attached to a UI Button Click)
  try {
    console.log('Requesting serial port access...');
    
    // Note: In a real browser, this requires a user gesture (e.g., button click).
    await rfid.connect();

    console.log('Configuring reader settings...');
    
    // Set detection power and thresholds (Level 1-7)
    await rfid.setDetectionLevel(3);
    
    // Only process tags starting with 'E200'
    rfid.setAccessFilter('E200');
    
    // Tag must be seen consistently for 500ms before emitting
    rfid.setPresenceStabilityTime(500); 

    // 4. Start Hardware Polling
    console.log('Starting inventory scan...');
    await rfid.startInventory();

    // Example of stopping after 10 seconds
    setTimeout(async () => {
      console.log('Stopping inventory scan...');
      await rfid.stopInventory();
      await rfid.disconnect();
    }, 10000);

  } catch (error) {
    console.error('Failed to initialize RFID sequence:', error);
  }
}

// In a real web application, bind the execution to a user gesture to satisfy Web Serial API security requirements:
// document.getElementById('connect-button').addEventListener('click', main);

// Automatically execute for the purpose of this script (will fail in browser without user gesture)
main();
