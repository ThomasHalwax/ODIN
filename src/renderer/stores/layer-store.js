import electron, { ipcRenderer } from 'electron'
import now from 'nano-time'
import uuid from 'uuid-random'
import * as R from 'ramda'
import { db } from './db'
import { clipboard } from '../components/App.clipboard'

/* ++ experimental fs store with git features */
import fs from 'fs'
import path from 'path'
import * as git from 'isomorphic-git'

git.plugins.set('fs', fs)

let updateSequence = 0
let persistedUpdateSequence = 0

const ROOT_FOLDER = path.join((electron.app || electron.remote.app).getPath('userData'), 'ODIN-fs-store')

const initializeGitStore = async (path) => {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path)
  }
  try {
    const initResult = await git.init({
      gitdir: path,
      noOverwrite: true
    })
    console.log(`initialized git repo at ${path}`)
    console.dir(initResult)
  } catch (error) {
    console.error(error)
  }
}

const writeLayer = (state, layerId) => {
  console.log(`updateSequence: ${updateSequence} -- persistedUpdateSequence: ${persistedUpdateSequence}`)
  if (updateSequence === persistedUpdateSequence) {
    console.log('nothing has changed, skipping git persistance')
    return
  }
  console.time('save-layer-and-commit')
  const fileName = `layer-${layerId}.json`
  const fullPathAndFileName = path.join(ROOT_FOLDER, fileName)
  const content = JSON.stringify(state[layerId], null, 2)
  fs.writeFile(fullPathAndFileName, content, error => {
    if (error) {
      return console.error(error)
    }
    console.log(`done persisting ${fullPathAndFileName}`)
    git.add({
      dir: ROOT_FOLDER,
      filepath: fileName
    })
      .then(() => {
        return git.commit({
          dir: ROOT_FOLDER,
          author: {
            name: 'thomas',
            email: 'thomas.halwax@syncpoint.io'
          },
          message: `persisted layer id ${layerId}`
        })
      })
      .then(sha => {
        console.log(`commited changes with hash ${sha}`)
        persistedUpdateSequence = updateSequence
      })
      .catch(error => {
        console.error(error)
      })
  })
  console.timeEnd('save-layer-and-commit')
}

const deleteLayer = deleteLayerEvent => {
  const layerFileName = `layer-${deleteLayerEvent.layerId}.json`
  const fullPath = path.join(ROOT_FOLDER, layerFileName)
  if (!fs.existsSync(fullPath)) return
  fs.unlinkSync(fullPath)
  git.remove({
    gitdir: ROOT_FOLDER,
    filepath: layerFileName
  })
    .then(() => {
      return git.commit({
        dir: ROOT_FOLDER,
        author: {
          name: 'thomas',
          email: 'thomas.halwax@syncpoint.io'
        },
        message: `removed layer ${deleteLayerEvent.layerId}`
      })
    })
    .catch(error => {
      console.error(error)
    })
}

/* -- experimantal fs store ... */

// TODO: purge snapshots/events

const evented = {}
let state = {} // in-memory snapshot

let eventCount = 0
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
  if (eventCount < 500) eventCount += 1
  else {
    db.put(`layer:snapshot:${now()}`, { type: 'snapshot', snapshot: state })
    eventCount = 0
  }

  const handler = handlers[event.type]
  if (handler) handler(event)
}

const persist = event => {
  db.put(`layer:journal:${now()}`, event)
  // updateSequence is required for experimantal fs git
  updateSequence++
  reduce(event)
  reducers.forEach(reduce => reduce(event))
}

const replay = reduce => {
  const snapshotOptions = () => ({
    gte: 'layer:snapshot:',
    lte: 'layer:snapshot:\xff',
    keys: true,
    reverse: true,
    limit: 1
  })

  const journalOptions = timestamp => ({
    gte: `layer:journal:${timestamp || ''}`,
    lte: 'layer:journal:\xff',
    keys: false
  })

  const replayJournal = options => new Promise((resolve, reject) => {
    db.createReadStream(options)
      .on('data', event => reduce(event))
      .on('error', err => reject(err))
      .on('end', () => resolve())
  })

  const replaySnapshot = options => new Promise((resolve, reject) => {
    let timestamp

    const handleSnapshot = ({ key, value }) => {
      timestamp = key.split(':')[2]
      reduce(value)
    }

    db.createReadStream(options)
      .on('data', handleSnapshot)
      .on('error', err => reject(err))
      .on('end', () => resolve(timestamp)) // undefined: no snapshot
  })

  return replaySnapshot(snapshotOptions())
    .then(timestamp => journalOptions(timestamp))
    .then(options => replayJournal(options))
    .then(() => reduce({ type: 'replay-ready' }))
}

replay(reduce).then(() => reducers.push(reduce))

// Add new or replace existing layer.
evented.addLayer = (layerId, name) => {
  // Delete layer with same name, if one exists:
  const existing = Object.entries(state).find(([_, layer]) => layer.name === name)
  if (existing) persist({ type: 'layer-deleted', layerId: existing[0] })
  persist({ type: 'layer-added', layerId, name, show: true })
  writeLayer(state, layerId)
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
