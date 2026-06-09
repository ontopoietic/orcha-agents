/**
 * ObservationsDetailPage
 *
 * Full-page split-view variant of the ObservationsViewer dialog. Opens in a
 * new PanelSlot via routes.view.observations(). Reads the active session
 * directory from observationsSessionDirAtom (the SessionAnchorBar trigger
 * sets it before pushing the panel).
 *
 * Same card grid + sources/refresh footer as the dialog — just without the
 * Dialog chrome and with much more room for long bullets and excerpts.
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { observationsSessionDirAtom } from '@/atoms/panel-stack'
import { ObservationsContent } from '@/components/anchors/ObservationsViewer'

export default function ObservationsDetailPage() {
  const sessionDir = useAtomValue(observationsSessionDirAtom)
  return <ObservationsContent sessionDir={sessionDir} />
}
