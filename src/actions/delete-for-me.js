/**
 * Removes the crash payload from this device.
 *
 * - `for-me`  : the real "delete for me" — an app-state patch, works even though
 *               the sender owns the message.
 * - `revoke-if-able`: tries "delete for everyone" (only succeeds for messages this
 *               account sent, or where the server allows the revoke), then falls
 *               back to for-me so the phone is protected either way.
 */
export const deleteBugMessage = async ({ conn, chatJid, key, timestampSec, mode = 'for-me', deleteMedia = true, store }) => {
  if (mode === 'off') return { status: 'skip', detail: 'delete disabled' };
  if (!chatJid || !key?.id) return { status: 'fail', detail: 'missing chat or message key' };

  const stamp = Number(timestampSec || Math.floor(Date.now() / 1000));

  if (mode === 'revoke-if-able') {
    try {
      await conn.sendMessage(chatJid, { delete: { remoteJid: chatJid, fromMe: false, id: key.id, participant: key.participant } });
      store?.increment?.('deleted');
      return { status: 'ok', detail: 'revoked for everyone', channel: 'revoke' };
    } catch (error) {
      const fallback = await forMe({ conn, chatJid, key, stamp, deleteMedia });
      if (fallback.status === 'ok') {
        return { ...fallback, detail: `revoke refused (${short(error.message)}) — deleted for me instead`, attempted: 'revoke' };
      }
      return { ...fallback, attempted: 'revoke', error };
    }
  }

  return forMe({ conn, chatJid, key, stamp, deleteMedia }).then((result) => {
    if (result.status === 'ok') store?.increment?.('deleted');
    return result;
  });
};

const forMe = async ({ conn, chatJid, key, stamp, deleteMedia }) => {
  try {
    await conn.chatModify(
      { deleteForMe: { deleteMedia, key: { remoteJid: chatJid, fromMe: false, id: key.id, participant: key.participant }, timestamp: stamp } },
      chatJid
    );
    return { status: 'ok', detail: 'deleted for me (device + linked devices)', channel: 'for-me' };
  } catch (error) {
    return { status: 'fail', detail: `delete for me failed: ${short(error.message)}`, error };
  }
};

const short = (message) => String(message || 'unknown error').split('\n')[0].slice(0, 90);

export const clearChatForMe = async ({ conn, chatJid }) => {
  try {
    await conn.chatModify({ clear: true, lastMessages: [] }, chatJid);
    return { status: 'ok', detail: 'chat cleared on this device' };
  } catch (error) {
    return { status: 'fail', detail: short(error.message), error };
  }
};

export default { deleteBugMessage, clearChatForMe };
