import {map} from "./array";
import constant from "./constant";
import {RuntimeError} from "./errors";
import identity from "./identity";
import noop from "./noop";

export var TYPE_NORMAL = 1; // a normal variable
export var TYPE_IMPLICIT = 2; // created on reference
export var TYPE_DUPLICATE = 3; // created on duplicate definition

export var variable_invalidate = {};

export default function Variable(type, module, node) {
  Object.defineProperties(this, {
    _definition: {value: variable_undefined, writable: true},
    _duplicate: {value: undefined, writable: true},
    _duplicates: {value: undefined, writable: true},
    _indegree: {value: 0, writable: true}, // The number of computing inputs.
    _inputs: {value: [], writable: true},
    _invalidate: {value: noop, writable: true},
    _module: {value: module},
    _name: {value: null, writable: true},
    _node: {value: node, writable: true},
    _outputs: {value: new Set, writable: true},
    _promise: {value: undefined, writable: true},
    _reachable: {value: node != null, writable: true}, // Is this variable transitively visible?
    _rejector: {value: variable_rejector(this)},
    _type: {value: type},
    _value: {value: undefined, writable: true},
    _version: {value: 0, writable: true}
  });
}

Object.defineProperties(Variable.prototype, {
  _resolve: {value: variable_resolve, writable: true, configurable: true},
  attach: {value: variable_attach_node, writable: true, configurable: true},
  detach: {value: variable_detach_node, writable: true, configurable: true},
  define: {value: variable_define, writable: true, configurable: true},
  delete: {value: variable_delete, writable: true, configurable: true},
  import: {value: variable_import, writable: true, configurable: true}
});

function variable_attach(variable) {
  variable._module._runtime._dirty.add(variable);
  variable._outputs.add(this);
}

function variable_detach(variable) {
  variable._module._runtime._dirty.add(variable);
  variable._outputs.delete(this);
}

function variable_attach_node(node) {
  const runtime = this._module._runtime;
  this._node = node;
  this._reachable = true;
  runtime._updates.add(this);
  runtime._compute();
}

function variable_detach_node() {
  const runtime = this._module._runtime;
  this._node.removeChild(this._node.firstChild);
  this._node = null;
  this._reachable = false;
  runtime._dirty.add(this);
  runtime._compute();
}

function variable_resolve(name) {
  return name === "invalidation"
      ? new Variable(TYPE_IMPLICIT, this._module).define(variable_invalidate)
      : this._module._resolve(name);
}

function variable_undefined() {
  throw variable_undefined;
}

function variable_rejector(variable) {
  return function(error) {
    if (error === variable_undefined) throw new RuntimeError(variable._name + " is not defined", variable._name);
    throw new RuntimeError(variable._name + " could not be resolved", variable._name);
  };
}

function variable_duplicate(name) {
  return function() {
    throw new RuntimeError(name + " is defined more than once");
  };
}

function variable_define(name, inputs, definition) {
  switch (arguments.length) {
    case 1: {
      definition = name, name = inputs = null;
      break;
    }
    case 2: {
      definition = inputs;
      if (typeof name === "string") inputs = null;
      else inputs = name, name = null;
      break;
    }
  }
  return variable_defineImpl.call(this,
    name == null ? null : name + "",
    inputs == null ? [] : map.call(inputs, this._resolve, this),
    typeof definition === "function" ? definition : constant(definition)
  );
}

function variable_defineImpl(name, inputs, definition) {
  var scope = this._module._scope, runtime = this._module._runtime;

  this._inputs.forEach(variable_detach, this);
  inputs.forEach(variable_attach, this);
  this._inputs = inputs;
  this._definition = definition;
  this._value = undefined;

  // Did the variable’s name change? Time to patch references!
  if (name == this._name && scope.get(name) === this) {
    this._outputs.forEach(runtime._updates.add, runtime._updates);
  } else {
    var error, found;

    if (this._name) { // Did this variable previously have a name?
      if (this._outputs.size) { // And did other variables reference this variable?
        scope.delete(this._name);
        found = this._resolve(this._name);
        found._outputs = this._outputs, this._outputs = new Set;
        found._outputs.forEach(function(output) { output._inputs[output._inputs.indexOf(this)] = found; }, this);
        found._outputs.forEach(runtime._updates.add, runtime._updates);
        runtime._dirty.add(found).add(this);
        scope.set(this._name, found);
      } else if ((found = scope.get(this._name)) === this) { // Do no other variables reference this variable?
        scope.delete(this._name); // It’s safe to delete!
      } else if (found._type === TYPE_DUPLICATE) { // Do other variables assign this name?
        found._duplicates.delete(this); // This variable no longer assigns this name.
        this._duplicate = undefined;
        if (found._duplicates.size === 1) { // Is there now only one variable assigning this name?
          found = found._duplicates.keys().next().value; // Any references are now fixed!
          error = scope.get(this._name);
          found._outputs = error._outputs, error._outputs = new Set;
          found._outputs.forEach(function(output) { output._inputs[output._inputs.indexOf(error)] = found; });
          found._definition = found._duplicate, found._duplicate = undefined;
          runtime._dirty.add(error).add(found);
          runtime._updates.add(found);
          scope.set(this._name, found);
        }
      } else {
        throw new Error;
      }
    }

    if (this._outputs.size) throw new Error;

    if (name) { // Does this variable have a new name?
      if (found = scope.get(name)) { // Do other variables reference or assign this name?
        if (found._type === TYPE_DUPLICATE) { // Do multiple other variables already define this name?
          this._definition = variable_duplicate(name), this._duplicate = definition;
          found._duplicates.add(this);
        } else if (found._type === TYPE_IMPLICIT) { // Are the variable references broken?
          this._outputs = found._outputs, found._outputs = new Set; // Now they’re fixed!
          this._outputs.forEach(function(output) { output._inputs[output._inputs.indexOf(found)] = this; }, this);
          runtime._dirty.add(found).add(this);
          scope.set(name, this);
        } else { // Does another variable define this name?
          found._duplicate = found._definition, this._duplicate = definition; // Now they’re duplicates.
          error = new Variable(TYPE_DUPLICATE, this._module);
          error._name = name;
          error._definition = this._definition = found._definition = variable_duplicate(name);
          error._outputs = found._outputs, found._outputs = new Set;
          error._outputs.forEach(function(output) { output._inputs[output._inputs.indexOf(found)] = error; });
          error._duplicates = new Set([this, found]);
          runtime._dirty.add(found).add(error);
          runtime._updates.add(found).add(error);
          scope.set(name, error);
        }
      } else {
        scope.set(name, this);
      }
    }

    this._name = name;
  }

  runtime._updates.add(this);
  runtime._compute();
  return this;
}

function variable_import(name, alias, module) {
  if (arguments.length < 3) module = alias, alias = name;
  return variable_defineImpl.call(this, alias + "", [module._resolve(name + "")], identity);
}

function variable_delete() {
  return variable_defineImpl.call(this, null, [], noop);
}
