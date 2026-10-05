'use strict'

// Sérialisation JSON déterministe (clés triées) : deux pairs qui reçoivent
// le même objet produisent exactement les mêmes octets à signer/vérifier.
function canonical (value) {
  if (value === null || typeof value !== 'object') {
    const out = JSON.stringify(value)
    if (out === undefined) throw new TypeError('Valeur non sérialisable')
    return out
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
}

module.exports = { canonical }
