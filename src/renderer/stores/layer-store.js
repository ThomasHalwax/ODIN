import { ipcRenderer } from 'electron'
import uuid from 'uuid-random'
import * as R from 'ramda'
import { clipboard } from '../components/App.clipboard'

/* ++ experimental fs store with git features */
import fs from 'fs'
import path from 'path'
import * as git from 'isomorphic-git'
import os from 'os'

let updateSequence = 0
let persistedUpdateSequence = 0

const ROOT_FOLDER = path.join(os.homedir(), 'ODIN-Layers')

const GIT_AUTHOR = {
  name: os.userInfo().username,
  email: `${os.userInfo().username}@${os.hostname()}`
}

// gets called for C_UD oberations
const commit = message => git.commit({
  fs,
  dir: ROOT_FOLDER,
  author: GIT_AUTHOR,
  message: message
})

const initializeGitStore = async (path) => {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path)
  }
  /* git init runs every time the app starts, so noOverwrite MUST BE TRUE to avoid data loss */
  try {
    await git.init({
      fs,
      dir: path,
      noOverwrite: true
    })
    console.log(`initialized git repo at ${path}`)
  } catch (error) {
    console.error(`failed to initialize git repository ${path}: ${error.message}`)
  }
}

const writeLayer = async (state, layerId) => {
  console.log(`updateSequence: ${updateSequence} -- persistedUpdateSequence: ${persistedUpdateSequence}`)
  if (updateSequence === persistedUpdateSequence) {
    console.log('nothing has changed, skipping git persistance')
    return
  }

  const fileName = `${layerId}.json`
  const fullPathAndFileName = path.join(ROOT_FOLDER, fileName)

  try {
    console.time('save-layer-and-commit')
    const content = JSON.stringify(state[layerId], null, 2)
    await fs.promises.writeFile(fullPathAndFileName, content)
    console.log(`done persisting ${fullPathAndFileName}`)
    await git.add({
      fs,
      dir: ROOT_FOLDER,
      filepath: fileName
    })
    const commitHash = await commit(`persisted layer id ${layerId}`)
    console.log(`commited changes with hash ${commitHash}`)
    persistedUpdateSequence = updateSequence
  } catch (error) {
    console.error(`failed to write layer ${layerId}: ${error.message}`)
  } finally {
    console.timeEnd('save-layer-and-commit')
  }
}

const deleteLayer = async deleteLayerEvent => {
  const layerFileName = `${deleteLayerEvent.layerId}.json`
  const fullPath = path.join(ROOT_FOLDER, layerFileName)

  if (!fs.existsSync(fullPath)) return
  try {
    await fs.promises.unlink(fullPath)
    await git.remove({
      fs,
      dir: ROOT_FOLDER,
      filepath: layerFileName
    })
    const commitHash = await commit(`deleted layer ${deleteLayerEvent.layerId}`)
    console.log(`commited changes with hash ${commitHash}`)
  } catch (error) {
    console.error(`failed to delete layer ${deleteLayerEvent.layerId}: ${error.message}`)
  }
}

/* -- experimantal fs store ... */
const evented = {}
let state = {} // in-memory snapshot

const reducers = []

const handlers = {
  'snapshot': ({ snapshot }) => (state = snapshot),
  'layer-added': ({ layerId, name, show }) => (state[layerId] = { name, show, features: {} }),
  'bounds-updated': ({ layerId, bbox }) => (state[layerId].bbox = bbox),
  'layer-deleted': ({ layerId }) => delete state[layerId],
  'layer-hidden': ({ layerId }) => (state[layerId].show = false),
  'layer-shown': ({ layerId }) => (state[layerId].show = true),
  'feature-added': ({ layerId, featureId, feature }) => (state[layerId].features[featureId] = feature),
  'feature-updated': ({ layerId, featureId, feature }) => (state[layerId].features[featureId] = feature),
  'feature-deleted': ({ layerId, featureId }) => delete state[layerId].features[featureId]
}

const reduce = event => {
  const handler = handlers[event.type]
  if (handler) handler(event)
}

const persist = event => {
  // updateSequence is required for experimental fs git
  updateSequence++
  reduce(event)
  reducers.forEach(reduce => reduce(event))
}


const replay = reduce => {
  const enumerateDirectoryEntries = fs.promises.readdir(ROOT_FOLDER, { withFileTypes: true })

  const entriesThatAreFiles = dirEntries => dirEntries.filter(dirEntry => dirEntry['isFile']())
  const fileExtensionIsJson = dirEntries => dirEntries.filter(entry => entry.name.endsWith('.json'))
  const extractFileNames = dirEntries => dirEntries.map(entry => entry.name)
  const loadContent = fileName => fs.readFileSync(path.join(ROOT_FOLDER, fileName), 'utf8')

  return enumerateDirectoryEntries
    .then(entriesThatAreFiles)
    .then(fileExtensionIsJson)
    .then(extractFileNames)
    .then(fileNames => {
      const snapshot = {}
      fileNames.forEach(fileName => {
        const content = loadContent(fileName)
        const layerId = fileName.split('.')[0]
        snapshot[layerId] = JSON.parse(content)
      })

      reduce({
        snapshot: snapshot,
        type: 'snapshot'
      })
    })
    .then(() => reduce({ type: 'replay-ready' }))
}

replay(reduce).then(() => reducers.push(reduce))

// Add new or replace existing layer.
evented.addLayer = (layerId, name) => {
  // Delete layer with same name, if one exists:
  const existing = Object.entries(state).find(([_, layer]) => layer.name === name)
  if (existing) persist({ type: 'layer-deleted', layerId: existing[0] })
  persist({ type: 'layer-added', layerId, name, show: true })
}

evented.updateBounds = (layerId, bbox) => {
  if (!state[layerId]) return
  persist({ type: 'bounds-updated', layerId, bbox })
}

// Delete zero, one or more layers.
evented.deleteLayer = layerIds => (layerIds || Object.keys(state))
  .filter(layerId => state[layerId])
  .map(layerId => ({ type: 'layer-deleted', layerId }))
  .forEach(deleteLayerEvent => {
    persist(deleteLayerEvent)
    deleteLayer(deleteLayerEvent)
  })

evented.hideLayer = layerIds => (layerIds || Object.keys(state))
  .filter(layerId => state[layerId])
  .map(layerId => ({ type: 'layer-hidden', layerId }))
  .forEach(persist)

evented.showLayer = layerIds => (layerIds || Object.keys(state))
  .filter(layerId => state[layerId])
  .map(layerId => ({ type: 'layer-shown', layerId }))
  .forEach(persist)

evented.addFeature = layerId => (featureId, feature) => {
  layerId = Number.isInteger(layerId) ? layerId.toString() : layerId
  if (layerId === '0' && !state[layerId]) {
    persist({ type: 'layer-added', layerId: '0', name: 'Default Layer', show: true })
  }

  // Implicitly show layer when currently hidden.
  if (!state[layerId].show) persist({ type: 'layer-shown', layerId })

  // Feature already exists -> bail out.
  if (state[layerId].features[featureId]) return
  persist({ type: 'feature-added', layerId, featureId, feature })
}

evented.updateFeature = layerId => (featureId, feature) => persist({
  type: 'feature-updated',
  layerId,
  featureId,
  // NOTE: Allows for partial updates:
  feature: R.mergeDeepRight(state[layerId].features[featureId], feature)
})

evented.deleteFeature = layerId => featureId => {
  if (!state[layerId]) return
  if (!state[layerId].features[featureId]) return
  persist({ type: 'feature-deleted', layerId, featureId })
}

evented.layer = layerId => state[layerId]
evented.feature = (layerId, featureId) => state[layerId].features[featureId]

evented.register = reduce => {
  replay(reduce)
  reducers.push(reduce)
}

// Command API ==>

const commands = {}
evented.commands = commands

commands.update = (layerId, featureId) => feature => {
  const factory = (current, feature) => ({
    run: () => evented.updateFeature(layerId)(featureId, feature),
    inverse: () => factory(feature, current)
  })

  const current = R.clone(evented.feature(layerId, featureId))
  return factory(current, feature)
}

/* experimental fs git */
commands.commit = (layerId) => {
  writeLayer(state, layerId)
}

// Clipboard handlers ==>

clipboard.register('feature', {
  properties: urn => {
    const [layerId, featureId] = urn.split(':').slice(2)
    return R.clone(state[layerId].features[featureId])
  },
  'delete': urn => {
    const [layerId, featureId] = urn.split(':').slice(2)
    evented.deleteFeature(layerId)(featureId)
  },
  paste: feature => evented.addFeature(0)(uuid(), feature)
})

ipcRenderer.on('COMMAND_LOAD_LAYER', (_, name, collection) => {
  if (!collection.type === 'FeatureCollection') return
  const layerId = uuid()
  evented.addLayer(layerId, name)
  collection.features.forEach(feature => evented.addFeature(layerId)(uuid(), feature))
})

;(async () => {
  await initializeGitStore(ROOT_FOLDER)
})()

export default evented
