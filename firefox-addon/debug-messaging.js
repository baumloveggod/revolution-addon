/**
 * Debug script to check messaging registration
 * Run this in Firefox Browser Console
 */

(async function debugMessaging() {
  console.log('=== MESSAGING DEBUG ===');

  // 1. Check if addon is loaded
  console.log('1. Checking addon state...');
  const state = await browser.storage.local.get('rev_connector_state');
  console.log('   State:', state);

  if (!state.rev_connector_state) {
    console.error('❌ No addon state found - user might not be logged in');
    return;
  }

  const { userToken, profile } = state.rev_connector_state;
  console.log('   User:', profile?.username || 'unknown');
  console.log('   Token:', userToken ? '✓ present' : '✗ missing');

  // 2. Check messaging keypair
  console.log('\n2. Checking messaging keys...');
  const keypair = await browser.storage.local.get('messaging_keypair');
  const signingKeypair = await browser.storage.local.get('messaging_signing_keypair');
  const groupId = await browser.storage.local.get('messaging_group_id');
  const fingerprint = await browser.storage.local.get('messaging_fingerprint');

  console.log('   Keypair:', keypair.messaging_keypair ? '✓ exists' : '✗ missing');
  console.log('   Signing keypair:', signingKeypair.messaging_signing_keypair ? '✓ exists' : '✗ missing');
  console.log('   Group ID:', groupId.messaging_group_id || '✗ missing');
  console.log('   Fingerprint:', fingerprint.messaging_fingerprint || '✗ missing');

  // 3. Check server registration
  if (userToken && groupId.messaging_group_id) {
    console.log('\n3. Checking server registration...');
    try {
      const response = await fetch(`https://msg.lenkenhoff.de/keys?groupId=${groupId.messaging_group_id}`, {
        headers: {
          'Authorization': `Bearer ${userToken}`
        }
      });

      const data = await response.json();
      console.log('   Server response:', data);
      console.log('   Registered clients:', data.keys?.length || 0);

      if (data.keys && fingerprint.messaging_fingerprint) {
        const isRegistered = data.keys.some(k => k.fingerprint === fingerprint.messaging_fingerprint);
        console.log('   This client registered:', isRegistered ? '✓ YES' : '✗ NO');

        if (!isRegistered) {
          console.warn('⚠️ This addon is NOT registered on the server!');
          console.log('   Expected fingerprint:', fingerprint.messaging_fingerprint);
          console.log('   Server has:', data.keys.map(k => k.fingerprint));
        }
      }
    } catch (error) {
      console.error('❌ Failed to check server:', error);
    }
  }

  console.log('\n=== DEBUG COMPLETE ===');
})();
