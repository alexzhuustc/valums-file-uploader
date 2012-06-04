"use strict";

var fs = require('fs');
var qs = require('querystring');
var util = require('util');
var path = require('path');
var crypto = require('crypto');
var EventEmitter = require('events').EventEmitter;

var join = path.join, dirname = path.dirname, extname = path.extname;

var defaults = {
  maxHeaderSize: 1024, //only for multipart parts
  maxBufferSize: 4096, //only when buffering entire response
  maxRequestSize: 0 //0 = unlimited
};

function BodyParser(req, res, opts) {
  this.req = req;
  this.res = res;
  this.headers = req.headers;
  this.opts = opts || {};
  this.opts.__proto__ = defaults;
  this.parsed = {files: {}, fields: {}};
  this.parse();
}
module.exports = BodyParser;

util.inherits(BodyParser, EventEmitter);

BodyParser.prototype.parse = function() {
  var parser = this;
  this.type = this.headers['content-type'] || '';
  this.type = this.type.toLowerCase().split(';')[0];
  this.length = parseInt(this.headers['content-length'], 10) || 0;
  switch(this.type) {
    case 'application/x-www-form-urlencoded':
      return this.processFormBody();
    case 'application/json':
      return this.processJSONBody();
    case 'multipart/form-data':
      return this.processMultiPartBody();
    case 'application/octet-stream':
      return this.processBinaryBody();
  }
  process.nextTick(function() {
    //we shouldn't emit on same tick
    parser.emit('error', 415 /* Unsupported Media Type */);
  });
};

BodyParser.prototype._bufferBody = function(callback) {
  var parser = this
    , buffer = []
    , bytesReceived = 0
    , maxBufferSize = this.opts.maxBufferSize;
  this.req.on('data', function(data) {
    bytesReceived += data.length;
    if (bytesReceived > maxBufferSize) {
      parser.error = 413 /* Request Entity Too Large */;
    } else {
      //if we use utf8 our chunks might split multi-byte chars
      buffer.push(data.toString('binary'));
    }
  });
  this.req.on('end', function() {
    if (parser.error) {
      parser.emit('error', parser.error);
    } else {
      callback(new Buffer(buffer.join(''), 'binary'));
    }
  });
};

BodyParser.prototype.processFormBody = function() {
  var parser = this;
  this._bufferBody(function(body) {
    try {
      parser.parsed.fields = qs.parse(body.toString('utf8'));
    } catch(e) {
      parser.emit('error', 400 /* Bad Request */);
      return;
    }
    parser.emit('end', parser.parsed);
  });
};

BodyParser.prototype.processJSONBody = function() {
  var parser = this;
  this._bufferBody(function(body) {
    try {
      parser.parsed.fields = JSON.parse(body.toString('utf8'));
    } catch(e) {
      parser.emit('error', 400 /* Bad Request */);
      return;
    }
    parser.emit('end', parser.parsed);
  });
};

BodyParser.prototype.processBinaryBody = function() {
  var parser = this
    , maxRequestSize = this.opts.maxRequestSize
    , bytesReceived = 0;
  var headers = this.req.headers;
  var file = new Part({
    'x-file-name': headers['x-file-name'],
    'content-type': headers['x-mime-type']
  });
  this.req.on('data', function(data) {
    if (bytesReceived == 0) {
      parser.emit('fileStart', file);
    }
    bytesReceived += data.length;
    if (maxRequestSize && bytesReceived > maxRequestSize) {
      parser.error = 413 /* Request Entity Too Large */;
      return;
    }
    file.write(data);
  });

  this.req.on('end', function() {
    if (parser.error) {
      parser.emit('error', parser.error);
    } else {
      file.end();
      parser._processMultipartItem(file);
      parser.emit('end', this.parsed);
    }
  });

};

BodyParser.prototype.processMultiPartBody = function() {
  var parser = this
    , maxHeaderSize = this.opts.maxHeaderSize
    , maxRequestSize = this.opts.maxRequestSize;
  var boundary = this.headers['content-type']
    , pos = boundary.indexOf('=');
  boundary = boundary.slice(pos + 1);
  if (!boundary) {
    this.error = 400 /* Bad Request */;
    return;
  }
  var boundary1 = '--' + boundary;
  var boundary2 = '\r\n--' + boundary;
  var buffer = '', bytesReceived = 0, currentPart;

  this.req.on('data', function(data) {
    bytesReceived += data.length;
    if (maxRequestSize && bytesReceived > maxRequestSize) {
      parser.error = 413 /* Request Entity Too Large */;
      return;
    }
    //we use "binary encoded string" since Buffer has no indexOf
    buffer += data.toString('binary');
    while (buffer.length) {
      if (!currentPart) {
        //header state
        var endHeader = buffer.indexOf('\r\n\r\n');
        if (endHeader > 0) {
          currentPart = new Part(buffer.slice(boundary1.length + 2, endHeader));
          parser.emit('fileStart', currentPart);
          buffer = buffer.slice(endHeader + 4);
        } else
        if (buffer.length > maxHeaderSize) {
          parser.error = 431 /* Request Header Fields Too Large */;
        } else {
          break;
        }
      } else {
        //body state
        var endBody = buffer.indexOf(boundary2);
        if (endBody >= 0) {
          //part of buffer belongs to current item
          currentPart.write(buffer.slice(0, endBody));
          currentPart.end();
          parser._processMultipartItem(currentPart);
          buffer = buffer.slice(endBody + 2);
          currentPart = null;
        } else {
          //buffer contains data and possibly partial boundary
          if (buffer.length > boundary2.length) {
            var chunk = buffer.slice(0, buffer.length - boundary2.length);
            currentPart.write(new Buffer(chunk, 'binary'));
            buffer = buffer.slice(0 - boundary2.length);
          } else {
            break;
          }
        }
      }
    }
  });

  this.req.on('end', function() {
    if (parser.error) {
      parser.emit('error', parser.error);
    } else {
      parser.emit('end', this.parsed);
    }
  });

};

BodyParser.prototype._processMultipartItem = function(part) {
  var headers = part.headers;
  var fieldName = part.fieldName;
  if (part.type == 'file') {
    var file = {
      headers: headers,
      contentType: headers['content-type'] || '',
      fieldName: fieldName,
      fileName: part.fileName,
      md5: part.hash
    };
    this.parsed.files[fieldName] = file;
    this.emit('fileEnd', fieldName, file);
  } else {
    var data = part.data.toString('utf8');
    this.parsed.fields[fieldName] = data;
    this.emit('field', fieldName, data);
  }
};



function Part(head) {
  var headers = this.headers = (typeof head == 'string') ? parseHeaders(head) : head;
  var disp = headers['content-disposition'] || '';
  if (disp) {
    var fieldName = disp.match(/\bname="(.*?)"/i);
    this.fieldName = fieldName && fieldName[1] || '';
    var fileName = disp.match(/\bfilename="(.*?)"/i);
    this.fileName = fileName && fileName[1];
  } else {
    this.fieldName = headers['x-field-name'] || '';
    this.fileName = headers['x-file-name'] || '';
  }
  //should we unescape field/file name?
  if (this.fileName == null) {
    this.type = 'field';
    this.chunks = [];
  } else {
    this.type = 'file';
    this.hash = crypto.createHash('md5');
  }
}

util.inherits(Part, EventEmitter);

Part.prototype.saveTo = function(path, callback) {
  if (this.type != 'file') {
    return;
  }
  if (this.savePath) {
    //already saving file
    return;
  }
  callback = callback || function() {};
  if (!this.chunks) {
    //buffer data while we open a file stream
    this.chunks = [];
  }
  var part = this;
  fs.stat(path, function(err, stat) {
    if (stat && stat.isDirectory()) {
      part.savePath = path;
      part.tempName = Math.floor(Math.random() * Math.pow(2, 53)).toString(36);
      var writeStream = fs.createWriteStream(join(path, part.tempName));
      writeStream.on('open', function(fd) {
        part._writeToStream(writeStream);
      });
    } else {
      //grab dir name and try again
      part.saveTo(dirname(path), callback);
    }
  });

};

Part.prototype._tryRename = function(name, callback) {
  if (!this.tempName || !name) {
    return;
  }
  var part = this, oldPath = join(this.savePath, part.tempName), newPath = join(this.savePath, name);
  path.exists(newPath, function(fileExists) {
    if (fileExists) {
      var newName = name.replace(/\.[^\.]*$/, '');
      newName = newName.replace(/(?:\[(\d+)\])?$/, function(_, num) {
        num = num ? parseInt(num) + 1 : 1;
        return '[' + num + ']';
      });
      part._tryRename(newName + extname(name), callback);
    } else {
      fs.rename(oldPath, newPath, function() {
        callback(newPath);
      });
    }
  });
};

Part.prototype._writeToStream = function(stream) {
  var part = this, chunk;
  if (part.chunks) {
    //drain the buffer
    while (chunk = part.chunks.shift()) {
      stream.write(chunk);
    }
  }
  //disable buffering
  part.chunks = null;
  var close = function() {
    stream.on('close', function() {
      part._tryRename(part.fileName, function(path) {
        part.emit('saved', path);
      });
    });
    stream.end();
  };
  if (part.complete) {
    close();
    return
  }
  part.on('data', function(data) {
    stream.write(data);
  });
  part.on('end', close);
};

Part.prototype.write = function(data) {
  if (this.type == 'file') {
    this.hash.update(data);
    this.emit('data', data);
  }
  if (this.chunks) {
    this.chunks.push(data);
  }
};

Part.prototype.end = function() {
  if (this.hash){
    this.hash = this.hash.digest('hex');
  }
  if (this.type == 'field') {
    this.data = new Buffer(this.chunks.join(''), 'binary');
  }
  this.complete = true;
  this.emit('end');
};



function parseHeaders(raw) {
  var headers = {}, all = raw.split('\r\n');
  for (var i = 0; i < all.length; i++) {
    var header = all[i], pos = header.indexOf(':');
    if (pos < 0) continue;
    var n = header.slice(0, pos), val = header.slice(pos + 1).trim(), key = n.toLowerCase();
    headers[key] = headers[key] ? headers[key] + ', ' + val : val;
  }
  return headers;
}
