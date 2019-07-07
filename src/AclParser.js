import N3 from 'n3'
import AclDoc from './AclDoc'
import prefixes from './prefixes'
import AclRule from './AclRule'
import { parseTurtle } from './utils'

/**
 * @module AclParser
 */

/**
 * @typedef AclParserOptions
 * @property {string} aclUrl - the url of the acl file
 * @property {string} fileUrl - the file for which the permissions will be parsed
 */

const predicates = {
  mode: `${prefixes.acl}mode`,
  agent: `${prefixes.acl}agent`,
  agentGroup: `${prefixes.acl}agentGroup`,
  agentClass: `${prefixes.acl}agentClass`,
  accessTo: `${prefixes.acl}accessTo`,
  default: `${prefixes.acl}default`,
  defaultForNew: `${prefixes.acl}defaultForNew`,
  type: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
}

const agentClasses = {
  public: `${prefixes.foaf}Agent`,
  authenticated: `${prefixes.acl}AuthenticatedAgent`
}

const types = {
  authorization: `${prefixes.acl}Authorization`
}

/**
 * @description Class for parsing a turtle representation of an acl file into an instance of the Acl class
 * @alias module:AclParser
 * @example
 * // Give a user read permissions to a file
 * const fileUrl = 'https://pod.example.org/private/'
 * const aclUrl = 'https://pod.example.org/private/file.acl' // Retrieve this from the acl field in the Link header
 * const turtle = await solid.auth.fetch(aclUrl)
 *
 * const parser = new AclParser({ fileUrl, aclUrl })
 * const doc = await parser.turtleToAclDoc(turtle)
 * doc.defaultAccessTo = fileUrl
 * doc.addRule(READ, 'https://other.web.id')
 *
 * const newTurtle = await parser.aclDocToTurtle(doc)
 * await solid.auth.fetch(aclUrl, { // TODO: Check if this works
 *   method: 'PUT',
 *   body: newTurtle
 * })
 */
class AclParser {
  /**
   * @param {AclParserOptions} options
   */
  constructor ({ fileUrl, aclUrl }) {
    this.parser = new N3.Parser({ baseIRI: aclUrl })
    this.subjectIdCounter = 0
    this.accessTo = fileUrl
  }

  /**
   * @param {string} aclTurtle
   * @returns {Promise<AclDoc>}
   */
  async turtleToAclDoc (aclTurtle) {
    const data = await parseTurtle(this.parser, aclTurtle)
    const doc = new AclDoc({ accessTo: this.accessTo })

    for (const [subjectId, quads] of Object.entries(data)) {
      if (this._isAclRule(quads)) {
        const aclRule = this._quadsToRule(quads)
        doc.addRule(aclRule, null, { subjectId })
      } else {
        doc.addOther(...quads)
      }
    }

    return doc
  }

  /**
   * @param {N3.Quad[]} quads
   * @returns {AclRule}
   */
  _quadsToRule (quads) {
    const rule = new AclRule()

    for (const quad of quads) {
      if (Object.values(predicates).includes(quad.predicate.id)) {
        this._addQuadToRule(rule, quad)
      } else {
        rule.otherQuads.push(quad)
      }
    }
    return rule
  }

  /**
   * @param {N3.Quad[]} quads
   * @returns {boolean}
   */
  _isAclRule (quads) {
    return quads.some(({ predicate, object: { value } }) => {
      return predicate.id === predicates.type &&
        value === types.authorization
    })
  }

  /**
   * @param {AclRule} rule
   * @param {N3.Quad} quad
   */
  _addQuadToRule (rule, quad) {
    const { predicate, object: { value } } = quad

    switch (predicate.id) {
      case predicates.mode:
        rule.permissions.add(value)
        break

      case predicates.accessTo:
        rule.accessTo.push(value)
        break

      case predicates.agent:
        rule.agents.addWebId(value)
        break

      case predicates.agentGroup:
        rule.agents.addGroup(value)
        break

      case predicates.agentClass:
        switch (value) {
          case agentClasses.public:
            rule.agents.addPublic()
            break

          case agentClasses.authenticated:
            rule.agents.addAuthenticated()
            break

          default:
            throw new Error('Unexpected value for agentClass: ' + value)
        }
        break

      case predicates.default:
        rule.default = value
        break

      // defaultForNew has been replaced by default
      // only for backwards compatibility
      case predicates.defaultForNew:
        rule.defaultForNew = value
        rule.default = value
        break

      case predicates.type:
        break

      default:
        throw new Error('Unexpected predicate: ' + predicate.id)
    }
  }

  /**
   * @param {AclDoc} doc
   * @returns {Promise<string>}
   */
  aclDocToTurtle (doc) {
    const writer = new N3.Writer({ prefixes })

    doc.minimizeRules()
    /** @type {N3.Quad[]} */
    const quads = []
    for (const [subjectId, rule] of Object.entries(doc.rules)) {
      const ruleQuads = this._ruleToQuads(subjectId, rule)
      quads.push(...ruleQuads)
    }
    quads.push(...doc.otherQuads)
    writer.addQuads(quads)

    return new Promise((resolve, reject) => {
      writer.end((error, result) => {
        if (error) {
          return reject(error)
        }
        return resolve(result)
      })
    })
  }

  /**
   * @param {string} subjectId
   * @param {AclRule} rule
   * @returns {N3.Quad[]}
   */
  _ruleToQuads (subjectId, rule) {
    const { DataFactory: { quad, namedNode } } = N3
    const quads = []
    subjectId = subjectId || ('acl-parser-subject-' + this.subjectIdCounter++)

    quads.push(quad(
      namedNode(subjectId),
      namedNode(predicates.type),
      namedNode(types.authorization)
    ))
    // Agents
    for (const webId of rule.agents.webIds) {
      quads.push(quad(
        namedNode(subjectId),
        namedNode(predicates.agent),
        namedNode(webId)
      ))
    }
    for (const group of rule.agents.groups) {
      quads.push(quad(
        namedNode(subjectId),
        namedNode(predicates.agentGroup),
        namedNode(group)
      ))
    }
    if (rule.agents.public) {
      quads.push(quad(
        namedNode(subjectId),
        namedNode(predicates.agentClass),
        namedNode(agentClasses.public)
      ))
    }
    if (rule.agents.authenticated) {
      quads.push(quad(
        namedNode(subjectId),
        namedNode(predicates.agentClass),
        namedNode(agentClasses.authenticated)
      ))
    }
    // accessTo
    for (const uri of rule.accessTo) { // TODO: Check if uri is the correct term
      quads.push(quad(
        namedNode(subjectId),
        namedNode(predicates.accessTo),
        namedNode(uri)
      ))
    }
    // Provides default permissions for contained items?
    if (typeof rule.default !== 'undefined') {
      quads.push(quad(
        namedNode(subjectId),
        namedNode(predicates.default),
        namedNode(rule.default)
      ))
    }
    if (typeof rule.defaultForNew !== 'undefined') {
      quads.push(quad(
        namedNode(subjectId),
        namedNode(predicates.defaultForNew),
        namedNode(rule.defaultForNew)
      ))
    }
    // Permissions
    for (const permission of rule.permissions) {
      quads.push(quad(
        namedNode(subjectId),
        namedNode(predicates.mode),
        namedNode(permission)
      ))
    }

    return quads
  }
}

export default AclParser
