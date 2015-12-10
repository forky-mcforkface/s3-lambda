/**
 * Gives access to batch operations over s3 files, as well as a promised base
 * wrapper around the s3 api.
 *
 * @author Wells Johnston <wells@littlstar.com>
 * @exports S3renity
 */

'use strict'

var aws = require('aws-sdk'),
  fs = require('fs');

const TYPE_S3 = 's3';
const TYPE_FILE = 'file';
const S3_PATH_ERROR = 'Context needs to be a valid s3 path. Ex: "s3://<bucket>/path/to/folder[/object]."';
const INPUT_FUNCTION_ERROR = '"func" must be a function.';

/**
 * Give access to batch operations over s3 files, as well as a promised base
 * wrapper around the s3 api.
 *
 * @author Wells Johnston <wells@littlstar.com>
 * @exports S3renity
 */

module.exports = S3renity;

/**
 * S3renity access to files in S3.
 *
 * @class S3renity
 * @constructor
 * @param {object} aws your aws credentials. this object contains two keys
 * access_key_id and secret_access_key
 */

function S3renity(conf) {

  if (!(this instanceof S3renity)) {
    return new S3renity();
  }

  if (!conf) conf = {};

  if (conf.key) {
    this.context(conf.key);
  }

  if (conf.access_key_id && conf.secret_access_key) {
    aws.config.update({
      accessKeyId: conf.access_key_id,
      secretAccessKey: conf.secret_access_key
    });
  }

  const s3 = new aws.S3();
  this.s3 = s3;
  this.verbose = conf.verbose || false;
  this._marker = conf.marker || '';
  this.encoding = conf.encoding || 'utf8';
  this.hasTarget = false;
}

/**
 * Set the working context based on an s3 key.
 *
 * @public
 * @param {string} key a key in the form: "s3://<your-bucket>/path/to/folder/"
 * @returns {S3renity} `this`
 */

S3renity.prototype.context = function(key) {
  const target = resolveKey(key);
  if (target.type != TYPE_S3) {
    throw new Error(S3_PATH_ERROR);
  }
  this.bucket = target.bucket;
  this.prefix = target.prefix;
  return this;
};

/**
 * Set the marker for the working context (file to start on)
 *
 * @public
 * @param {string} marker The marker to start with for getting objects.
 * @return {S3renity} `this`
 */

S3renity.prototype.marker = function(marker) {
  this._marker = marker;
  return this;
}

/**
 * Sets the working context encoding.
 *
 * @public
 * @param {string} encoding The type of encoding to use with S3 objects. Default is "utf8".
 * @return {S3renity} `this`
 */

S3renity.prototype.encode = function(encoding) {
  this.encoding = encoding;
  return this;
};

/**
 * Transforms the S3 object before proceeding.
 *
 * @param {function} transform The function to use to transform the object.
 * @return {S3renity} `this`
 */

S3renity.prototype.transform = function(transformer) {
  this.transformer = transformer;
  return this;
};

/**
 * Move the context from s3 objects to objects split by a delimiter.
 *
 * @public
 * @param {string} delimiter The character to split the document objects by.
 * Default is "\n"
 * @return {S3renity} `this`
 */

S3renity.prototype.split = function(delimiter) {
  this.delimiter = delimiter || '\n';
  return this;
};

/**
 * Sets the output directory for map or filter.  If a target is set, map and
 * filter write to that location instead of changing the original objects
 * themselves.
 *
 * @public
 * @param {string} target The location to send the output of map or filter.
 * @return {S3renity} `this`
 */

S3renity.prototype.target = function(target) {
  const output = resolveKey(target);
  if (output.type != TYPE_S3) {
    throw new Error(S3_PATH_ERROR);
  }
  this.targetBucket = output.bucket;
  this.targetPrefix = output.prefix;
  this.hasTarget = true;
  return this;
};

/**
 * Returns all the keys in the working context.
 *
 * @public
 * @return {promise} Fulfilled when all the keys are retrieved from s3.
 */

S3renity.prototype.list = function() {

  const _keys = (allKeys, marker, success, fail) => {
    this.listObjects(this.bucket, this.prefix, marker).then(keys => {
      if (keys.length == 0) {
        success(allKeys);
        return;
      }
      keys.forEach(key => {
        allKeys.push(key.Key);
        marker = key.Key;
      });
      _keys(allKeys, marker, success, fail);
      return;
    }).catch(fail);
  };

  return new Promise((success, fail) => {
    _keys([], this._marker, success, fail);
  });
};

/**
 * Join the objects in the working context by the given delimiter and return the
 * result.
 *
 * @public
 * @param {string} delimiter The character used to join the documents by.
 * Default is "\n"
 * @return {promise} Returns the body and `this` on success.
 */

S3renity.prototype.join = function(delimiter) {

  if (delimiter == null) delimiter = '\n';

  return new Promise((success, fail) => {
    this.list().then(keys => {
      let getPromises = [];
      keys.forEach(key => {
        getPromises.push(this.get(this.bucket, key));
      });
      Promise.all(getPromises).then(objects => {
        success(objects.join(delimiter));
      }).catch(fail);
    }).catch(fail);
  });
};

/**
 * Returns a promise that performs a function on each object in
 * the working context. When all the functions are done, the promise is
 * fulfilled.
 *
 * @public
 * @param {function} func This function takes an s3 object and performs a
 * synchronous function. If isAsync is true, func returns a promise.
 * @param {boolean} isAsync Optional, default is false. If set to true, this
 * indicates that func returns a
 * promise that should be executed.
 * @return {promise} Fulfilled when the mapper functions are done. Returns a
 * list of keys that were operated over.
 */

S3renity.prototype.forEach = function(func, isAsync) {

  if (typeof func != 'function') {
    throw new TypeError(INPUT_FUNCTION_ERROR);
  }

  if (isAsync == null) {
    isAsync = false;
  }

  const _eachObject = (keys, callback) => {
    if (keys.length == 0) {
      callback(null);
      return;
    }
    const key = keys.shift();
    this.get(this.bucket, key).then(body => {
      if (isAsync) {
        func(body).then(_ => {
          _eachObject(keys, callback);
        }).catch(callback);
      } else {
        try {
          func(body);
        } catch (e) {
          callback(e);
          return;
        }
        _eachObject(keys, callback);
      }
    }).catch(callback);
  };

  const _splitObjects = (keys, callback) => {
    if (keys.length == 0) {
      callback(null);
      return;
    }
    const key = keys.shift();
    this.splitObject(this.bucket, key, this.delimiter, this.encoding)
      .then(entries => {
        _eachSplit(entries).then(_ => {
          _splitObjects(keys, callback);
        }).catch(callback);
      }).catch(callback);
  };

  const _eachSplit = entries => {
    return new Promise((success, fail) => {
      if (isAsync) {
        let updates = [];
        entries.forEach(entry => {
          updates.push(func(entry));
        });
        Promise.all(updates).then(success).catch(fail);
      } else {
        try {
          entries.forEach(func);
          success();
        } catch (err) {
          fail(err);
        }
      }
    });
  };

  return new Promise((success, fail) => {
    this.list().then(keys => {
      if (this.delimiter == null) {
        _eachObject(keys, err => {
          if (err) {
            fail(err);
          } else {
            success();
          }
        });
      } else {
        _splitObjects(keys, err => {
          if (err) {
            fail(err);
          } else {
            success();
          }
        });
      }
    }).catch(fail);
  });
};

/**
 * Maps a function over the objects in the working context, replaceing each
 * with the return value.  If an output is specified, the objects will not be
 * overwritten, but rather copied to the target location.
 *
 * @public
 * @param {function} func The function to map over each object in the working
 * context. Func takes the object as a parameter and returns the value that
 * should replace it.
 * @param {boolean} isAsync Optional, default is false. If set to true, this
 * indicates that func returns a promise.
 * @return {promise} Fulfilled when map is complete.
 */

S3renity.prototype.map = function(func, isAsync) {

  if (typeof func != 'function') {
    throw new TypeError(INPUT_FUNCTION_ERROR);
  }

  if (isAsync == null) {
    isAsync = false;
  }

  const isSplit = this.delimiter != null;

  const _mapObject = (keys, callback) => {
    if (keys.length == 0) {
      callback(null);
      return;
    }
    let key = keys.shift();
    this.get(this.bucket, key).then(body => {
      if (isAsync) {
        func(body)
          .then(newBody => _output(key, newBody, keys, callback))
          .catch(callback);
      } else {
        try {
          let newBody = func(body);
          _output(key, newBody, keys, callback);
        } catch (e) {
          callback(e);
          return;
        }
      }
    }).catch(callback);
  };

  const _splitObjects = (keys, callback) => {
    if (keys.length == 0) {
      callback(null);
      return;
    }
    let key = keys.shift();
    this.splitObject(this.bucket, key, this.delimiter, this.encoding).then(
      entries => {
        _mapSplit(entries).then(newEntries => {
          let newBody = newEntries.join(this.delimiter);
          _output(key, newBody, keys, callback);
        }).catch(callback);
      }).catch(callback);
  };

  const _mapSplit = entries => {
    return new Promise((success, fail) => {
      if (isAsync) {
        let entryUpdates = [];
        entries.forEach(entry => {
          entryUpdates.push(func(entry));
        });
        Promise.all(entryUpdates).then(success).catch(fail);
      } else {
        try {
          success(entries.map(func));
        } catch (err) {
          fail(err);
        }
      }
    });
  };

  const _output = (key, body, keys, callback) => {
    if (this.hasTarget) {
      this
        .put(this.targetBucket, this.targetPrefix + getFileName(key), body)
        .then(_ => _continue(keys, callback))
        .catch(callback);
    } else {
      this.put(this.bucket, key, body)
        .then(_ => _continue(keys, callback))
        .catch(callback);
    }
  };

  const _continue = (keys, callback) => {
    if (isSplit) {
      _splitObjects(keys, callback);
    } else {
      _mapObject(keys, callback);
    }
  };

  return new Promise((success, fail) => {
    this.list().then(keys => {
      if (isSplit) {
        _mapObject(keys, err => {
          if (err) {
            fail(err);
          } else {
            success();
          }
        });
      } else {
        _splitObjects(keys, err => {
          if (err) {
            fail(err)
          } else {
            success();
          }
        });
      }
    }).catch(fail);
  });
};

/**
 * Reduce the objects in the working context to a single value.
 *
 * @param {function} func Function to execute on each value in the array, taking
 * three arguments:
 *   previousValue - The value previously returned in the last invocation of
 *   func
 *   currentValue  - The current entry being processed
 *   key           - The key of the current object being processed
 *   func either returns the updated value, or a promise that resolves to the
 *   updated value.
 * @param {string} initialValue Optional.  Value to use as the first argument to
 * the first call of func.
 * @param {boolean} isAsync Optional, defaults to false. If set to true, this
 * indicates that func returns a promise.
 * @return {promise} Returns the reduced result.
 */

S3renity.prototype.reduce = function(func, initialValue, isAsync) {

  if (typeof func != 'function') {
    throw new TypeError(INPUT_FUNCTION_ERROR);
  }

  if (isAsync == null) {
    isAsync = false;
  }

  var value = initialValue;

  const _reduceObjects = (keys, callback) => {
    if (keys.length == 0) {
      callback(null, value);
      return;
    }
    let key = keys.shift();
    this.get(this.bucket, key).then(body => {
      if (isAsync) {
        func(value, body, key).then(newValue => {
          value = newValue;
          _reduceObjects(keys, callback);
        }).catch(e => callback(e, null));
      } else {
        value = func(value, body, key);
        _reduceObjects(keys, callback);
      }
    }).catch(e => callback(e, null));
  };

  const _splitAndReduceObjects = (keys, callback) => {
    if (keys.length == 0) {
      callback(null, value);
      return;
    }
    key = keys.shift();
    this.splitObject(this.bucket, key, this.delimiter, this.encoding).then(
      entries => {
        _reduceSplitEntries(key, entries, err => {
          if (err) {
            callback(err, null);
            return;
          }
          _splitAndReduceObjects(keys, callback);
        });
      }).catch(e => callback(e, null));
  };

  const _reduceSplitEntries = (key, entries, done) => {
    if (entries.length == 0) {
      done();
      return;
    }
    let entry = entries.shift();
    if (isAsync) {
      func(value, entry, key).then(newValue => {
        value = newValue;
        _reduceSplitEntries(key, entries, done);
      }).catch(done);
    } else {
      try {
        value = func(value, entry, key);
        _reduceSplitEntries(key, entries, done);
      } catch (e) {
        done(e);
      }
    }
  };

  return new Promise((success, fail) => {
    this.list().then(keys => {
      if (this.delimiter == null) {
        _reduceObjects(keys, (err, result) => {
          if (err) {
            fail(err);
          } else {
            success(result);
          }
        });
      } else {
        _splitAndReduceObjects(keys, (err, result) => {
          if (err) {
            fail(err);
          } else {
            success(result);
          }
        });
      }
    }).catch(fail);
  });
};

/**
 * Filter the objects in the working context.
 *
 * @public
 * @param {function} func The function to filter objects by, returning true for
 * objects that should not be filtered and false for those that should. If
 * isAsync is set to true, func returns a promise that resolves to true or
 * false.
 * @param {boolean} isAsync Optional, defaults to false. If set to true, this
 * indicates that func returns a promise.
 */

S3renity.prototype.filter = function(func, isAsync) {

  if (typeof func != 'function') {
    throw new TypeError(INPUT_FUNCTION_ERROR);
  }

  if (isAsync == null) {
    isAsync = false;
  }

  var removeObjects = [];
  var keepObjects = [];

  // recursively get all objects and run filter function
  const _filterObjects = (keys, callback) => {
    if (keys.length == 0) {
      _finish(callback);
      return;
    }
    let key = keys.shift();
    this.get(this.bucket, key).then(body => {
      if (isAsync) {
        func(body).then(result => {
          checkResult(result);
          if (result) {
            keepObjects.push(key);
          } else {
            removeObjects.push(key);
          }
          _filterObjects(keys, callback);
        }).catch(callback);
      } else {
        try {
          var result = func(body);
        } catch (e) {
          callback(e);
          return;
        }
        checkResult(result);
        if (result) {
          keepObjects.push(key);
        } else {
          removeObjects.push(key);
        }
        _filterObjects(keys, callback);
      }
    }).catch(callback);
  };

  const _finish = callback => {
    if (this.hasTarget) {
      let promises = [];
      keepObjects.forEach(key => {
        let fileName = getFileName(key);
        promises.push(this.copy(this.bucket, key, this.targetBucket, this.targetPrefix + fileName));
      });
      Promise.all(promises).then(_ => {
        callback();
      }).catch(callback);
    } else {
      this.delete(this.bucket, removeObjects).then(_ => {
        callback(null);
      }).catch(callback);
    }
  };

  const _splitObjects = (keys, callback) => {
    if (keys.length == 0) {
      callback(null);
      return;
    }
    let key = keys.shift();
    this.splitObject(this.bucket, key, this.delimiter, this.encoding)
      .then(entries => {
        _filterSplitObject(entries).then(newEntries => {
          var targetBucket, targetKey;
          let newBody = newEntries.join(this.delimiter);
          if (this.hasTarget) {
            targetBucket = this.targetBucket;
            targetKey = this.targetPrefix + getFileName(key);
          } else {
            targetBucket = this.bucket;
            targetKey = key;
          }
          this.put(targetBucket, targetKey, newBody).then(_ => {
            _splitObjects(keys, callback);
          }).catch(callback);
        }).catch(callback);
      }).catch(callback);
  };

  // runs the filter function on a split (containing entries)
  const _filterSplitObject = entries => new Promise((success, fail) => {
    if (isAsync) {
      promises = [];
      entries.forEach(entry => {
        promises.push(func(entry));
      });
      Promise.all(promises).then(results => {
        let newSplitEntries = [];
        results.forEach((pass, i) => {
          if (pass) {
            newSplitEntries.push(entries[i]);
          }
          success(newSplitEntries);
        });
      }).catch(fail);
    } else {
      try {
        success(entries.filter(func));
      } catch (err) {
        fail(err);
      }
    }
  });

  const checkResult = result => {
    if (typeof result != 'boolean') {
      throw new TypeError('Filter function must return a boolean');
    }
  };

  return new Promise((success, fail) => {
    this.list().then(keys => {
      if (this.delimiter == null) {
        _filterObjects(keys, err => {
          if (err) {
            fail(err);
          } else {
            success();
          }
        });
      } else {
        _splitObjects(keys, err => {
          if (err) {
            fail(err);
          } else {
            success();
          }
        });
      }
    }).catch(fail);
  });
};

/**
 * Removes empty objects in the working context.
 *
 * @public
 * @return {promise} Purges empty files.
 */

S3renity.prototype.clean = function() {
  return this.filter(body => body.length > 0);
};

/**
 * Output the working context to a file or location in s3.
 *
 * @public
 * @param {string} target The location to write to.  Can be a local file,
 * s3 path like: s3://<bucket>/path/to/file, or an array of paths.
 * @return {promise} Fulfilled when the file is finished saving. Returns the
 * response either from `fs` or s3.
 */

S3renity.prototype.write = function(body, targets) {
  return new Promise((success, fail) => {
    if (typeof targets == 'string') {
      targets = [targets];
    }
    var outputPromises = [];
    targets.forEach(target => {
      target = resolveKey(target);
      outputPromises.push(new Promise((_success, _fail) => {
        if (target.type == TYPE_S3) {
          this
            .put(target.bucket, target.prefix, body)
            .then(_success).catch(_fail);
        } else if (target.type == TYPE_FILE) {
          fs.writeFile(target.file, body, (err, res) => {
            if (err) {
              _fail(err);
            } else {
              _success();
            }
          });
        }
      }));
    });
    Promise.all(outputPromises).then(success).catch(fail);
  });
};

/**
 * Splits an object in s3 by a delimiter and returns.
 *
 * @param {string} bucket The s3 bucket to use.
 * @param {string} key The key to the object.
 * @param {string} delimiter Optional, default is \n. The character to use in
 * the split over the object's body.
 * @param {string} encoding Optional, default is utf8.
 * @return {promise} Returns an array that is the split of the object.
 */

S3renity.prototype.splitObject = function(bucket, key, delimiter, encoding) {
  return new Promise((success, fail) => {
    if (delimiter == null) delimiter = '\n';
    if (encoding == null) encoding = 'utf8';
    this.get(bucket, key).then(body => {
      if (body == '') {
        success([]);
      } else {
        try {
          success(body.split(delimiter));
        } catch (err) {
          fail(err);
        }
      }
    }).catch(fail);
  });
};

/**
 * Returns a promise that gets an object from s3.
 *
 * @public
 * @param {string} arg1 Can either be a valid s3 path or a bucket.
 * @param {string} arg2 Optional. If arg1 is a bucket, arg2 is the key.
 * @return {promise} Fulfilled when object is retrieved.
 */

S3renity.prototype.get = function(arg1, arg2) {
  var target = resolveKey(arg1),
    bucket, key;
  if (this.verbose) {
    console.info('get object', target.bucket, target.prefix);
  }
  if (target.type == TYPE_S3) {
    bucket = target.bucket;
    key = target.prefix;
  } else {
    bucket = arg1;
    key = arg2;
  }
  return new Promise((success, fail) => {
    this.s3.getObject({
      Bucket: bucket,
      Key: key
    }, (err, object) => {
      if (err) {
        fail(err);
      } else {
        try {
          if (this.transformer == null) {
            success(object.Body.toString(this.encoding));
          } else {
            success(this.transformer(object.Body));
          }
        } catch (e) {
          fail(e);
        }
      }
    });
  });
};

/**
 * Returns a promise that puts an object in s3.
 *
 * @public
 * @param {string} bucket The s3 bucket to use.
 * @param {string} key The key path where the object will be placed.
 * @param {string} body The object body.
 * @return {promise} Fulfilled when the object is written to s3. Returns
 * response from s3.
 */

S3renity.prototype.put = function(bucket, key, body) {
  if (this.verbose) {
    console.info('put object', bucket, key);
  }
  return new Promise((success, fail) => {
    this.s3.putObject({
      Bucket: bucket,
      Key: key,
      Body: body
    }, (err, res) => {
      if (err) {
        fail(err);
      } else {
        success(res);
      }
    });
  });
};

/**
 * Copies an object in S3 from sourceKey to targetKey
 *
 * @public
 * @param {string} bucket The s3 bucket to use.
 * @param {string} sourceKey The source of the object to copy.
 * @param {string} targetKey The target to copy the object to in s3.
 */

S3renity.prototype.copy = function(sourceBucket, sourceKey, targetBucket, targetKey) {
  return new Promise((success, fail) => {
    this.s3.copyObject({
      Bucket: targetBucket,
      Key: targetKey,
      CopySource: `${sourceBucket}/${sourceKey}`
    }, (err, res) => {
      console.log(err, res);
      if (err) {
        fail(err);
      } else {
        success(res);
      }
    });
  });
};

/**
 * Returns a promise that deletes an object in S3.
 *
 * @public
 * @param {string} bucket The s3 bucket to use.
 * @param {string|array} keys The key of the object to delete, or an array of
 * keys.
 * @return {promise} Fulfilled when the object deleted. Returns `this`.
 */

S3renity.prototype.delete = function(bucket, key) {
  if (typeof key == 'object') {
    return this.deleteObjects(bucket, key);
  }
  if (this.verbose) {
    console.info('delete object', bucket, key);
  }
  return new Promise((success, fail) => {
    this.s3.deleteObject({
      Bucket: bucket,
      Key: key
    }, (err, res) => {
      if (err) {
        fail(err);
      } else {
        success(res);
      }
    });
  });
};

/**
 * Return a promise that gets keys from s3 given a bucket, prefix and marker.
 *
 * @public
 * @param {string} bucket The bucket to get the keys from.
 * @param {string} prefix The prefix for the folder where the keys are.
 * @param {string} [marker] The marker to start from (optional).
 * @return {promise} Fulfilled when the keys are retrieved from s3.
 */

S3renity.prototype.listObjects = function(bucket, prefix, marker) {
  return new Promise((success, fail) => {
    if (prefix[prefix.length - 1] != '/') prefix += '/';
    this.s3.listObjects({
      Bucket: bucket,
      Prefix: prefix,
      Marker: marker
    }, (err, keys) => {
      if (err) {
        fail(err);
      } else {
        keys = keys.Contents;
        if (keys.length && keys[0].Key == prefix) {
          keys.shift();
        }
        success(keys);
      }
    });
  });
};

/**
 * Deletes a list of objects in S3.
 *
 * @public
 * @param {string} bucket The s3 bucket to use.
 * @param {array} keys The keys of the objects to delete.
 * @return {promise} Fulfilled when objects are deleted. Returns response.
 */

S3renity.prototype.deleteObjects = function(bucket, keys) {
  if (this.verbose) {
    console.info('delete objects', bucket, keys);
  }
  return new Promise((success, fail) => {
    keys.map((key, i, arr) => {
      arr[i] = {
        Key: key
      };
    });
    this.s3.deleteObjects({
      Bucket: bucket,
      Delete: {
        Objects: keys
      }
    }, (err, res) => {
      if (err) {
        fail(err);
      } else {
        success(res);
      }
    });
  });
};

/**
 * Take a path or s3 key and resolve it.
 *
 * @private
 * @param {string} key an s3 key or local file path
 * @return {object} An object wity keys: bucket, prefix, file, and type.
 */

const resolveKey = key => {
  var target = {};
  if (key.indexOf('s3://') == 0) {
    key = key.substr(5, key.length - 1);
    target.bucket = key.split('/')[0];
    target.prefix = key.substr(key.indexOf('/') + 1, key.length);
    target.file = null;
    target.type = TYPE_S3;
  } else {
    target.bucket = null;
    target.prefix = null;
    target.file = key;
    target.type = TYPE_FILE;
  }
  return target;
};

/**
 * Returns the filename (last part of the key) from an S3 key.
 *
 * @private
 * @param {string} key The S3 key to get the file name for.
 * @return {string} The filename from the S3 key.
 */

const getFileName = key => key.substr(key.lastIndexOf('/') + 1, key.length);