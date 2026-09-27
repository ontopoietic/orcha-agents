import { unlink } from 'fs/promises'
import { join } from 'path'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { requestClientConfirmDialog } from '@craft-agent/server-core/transport'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.auth.LOGOUT,
  RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION,
  RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION,
  RPC_CHANNELS.credentials.HEALTH_CHECK,
] as const

/**
 * Logout: clear all stored credentials and the app config file.
 *
 * Mirrors upstream's intent (reset auth + config) but scoped to THIS app's
 * config dir. Fork: upstream hardcoded `~/.craft-agent/config.json`, so an
 * Orcha logout wiped the original Craft Agents app's config. The credential
 * manager's store is CONFIG_DIR/credentials.enc, so deleting its entries
 * only touches Orcha's own credentials.
 */
export async function performLogout(opts: {
  credentialManager: Pick<ReturnType<typeof getCredentialManager>, 'list' | 'delete'>
  configDir?: string
}): Promise<void> {
  const { credentialManager } = opts
  const configDir = opts.configDir ?? CONFIG_DIR

  // List and delete all stored credentials
  const allCredentials = await credentialManager.list()
  for (const credId of allCredentials) {
    await credentialManager.delete(credId)
  }

  // Delete the config file
  await unlink(join(configDir, 'config.json')).catch(() => {
    // Ignore if file doesn't exist
  })
}

export function registerAuthHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Show logout confirmation dialog (routed to client)
  server.handle(RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION, async (ctx) => {
    const result = await requestClientConfirmDialog(server, ctx.clientId, {
      type: 'warning',
      buttons: ['Cancel', 'Log Out'],
      defaultId: 0,
      cancelId: 0,
      title: 'Log Out',
      message: 'Are you sure you want to log out?',
      detail: 'All conversations will be deleted. This action cannot be undone.',
    })
    // result.response is the index of the clicked button
    // 0 = Cancel, 1 = Log Out
    return result.response === 1
  })

  // Show delete session confirmation dialog (routed to client)
  server.handle(RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION, async (ctx, name: string) => {
    const result = await requestClientConfirmDialog(server, ctx.clientId, {
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete Conversation',
      message: `Are you sure you want to delete: "${name}"?`,
      detail: 'This action cannot be undone.',
    })
    // result.response is the index of the clicked button
    // 0 = Cancel, 1 = Delete
    return result.response === 1
  })

  // Logout - clear all credentials and config
  server.handle(RPC_CHANNELS.auth.LOGOUT, async () => {
    try {
      await performLogout({ credentialManager: getCredentialManager() })

      deps.platform.logger.info('Logout complete - cleared all credentials and config')
    } catch (error) {
      deps.platform.logger.error('Logout error:', error)
      throw error
    }
  })

  // Credential health check - validates credential store is readable and usable
  // Called on app startup to detect corruption, machine migration, or missing credentials
  server.handle(RPC_CHANNELS.credentials.HEALTH_CHECK, async () => {
    const manager = getCredentialManager()
    return manager.checkHealth()
  })
}
