// worker 响应处理器
const workerResponseHandler = {};

// worker 池
// 活动的 woker 队列，完成工作后转到空闲队列
// 创建 woker 时，先从空闲队列中取，没有时再新建，新建后存放到活动队列
// 空闲队列至少保留一个 worker 以避免反复创建销毁
let activeWorkers = [];
let idleWorkers = [];

// worker 工作完成后执行该函数，10 秒钟后清理多余的 woker，只保留一个
let timeout = 0;
function clearIdleWorkers() {
  clearTimeout(timeout);
  timeout = setTimeout(() => {
    for (let i = 1, l = idleWorkers.length; i < l; i++) {
      idleWorkers[i].terminate();
      URL.revokeObjectURL(idleWorkers[i].url);
    }
    idleWorkers.length = 1;
  }, 10000);
}

// worker 脚本内容
const workerContent = (() => {
  self.onmessage = async (event) => {
    const { id, command, data, option = {}, fileHandle } = event.data;
    let accessHandle;
    function respond(result, error, transfer) {
      self.postMessage(
        {
          id,
          result,
          error,
        },
        transfer
      );
    }

    if (!id || !command || !fileHandle) {
      respond(null, new Error("missing id | command | fileHandle!"));
      return;
    }

    try {
      accessHandle = await fileHandle.createSyncAccessHandle();
      switch (command) {
        // 获取文件的大小
        case "getSize":
          respond(accessHandle.getSize());
          break;

        // 读取文件的内容到指定的缓冲区 buffer 中，可选择在给定的偏移处 at 开始读取。
        // 读取到的 buffer 将转移给主线程
        case "read":
          const fileSize = accessHandle.getSize();
          // const buffer = new DataView(
          //   new ArrayBuffer(fileSize - (option.at || 0))
          // );
          const buffer = new ArrayBuffer(fileSize - (option.at || 0));
          accessHandle.read(buffer, option);
          respond(buffer, undefined, [buffer]);
          break;

        // 将文件的大小调整为指定的字节数
        case "truncate":
          let truncateSize = 0;
          if (typeof option.size === "number" && option.size >= 0) {
            truncateSize = option.size;
            accessHandle.truncate(option.size);
            if (option.flush) {
              accessHandle.flush();
            }
          }
          respond(truncateSize);
          break;

        // 将指定缓冲区中的内容写入到文件，可选择在给定的偏移处开始写入。
        case "write":
          let writeSize = 0;
          if (data) {
            writeSize = accessHandle.write(data, option);
            if (option.flush) {
              accessHandle.flush();
            }
          }
          respond(writeSize);
          break;

        default:
          break;
      }
    } catch (error) {
      respond(null, error);
    } finally {
      if (accessHandle) {
        accessHandle.close();
      }
    }
  };
}).toString();

// 从空闲队列取出或创建新的 worker
function startWorker(msgData, transfer) {
  let worker = idleWorkers.pop();
  if (!worker) {
    const blob = new Blob([`(${workerContent})()`], {
      type: "text/javascript",
    });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
    worker.url = url;
  }
  activeWorkers.push(worker);
  worker.onmessage = (e) => {
    handleWorkerResponse(e.data);
    completeWork(worker);
    clearIdleWorkers();
  };
  worker.postMessage(msgData, transfer);
  return worker;
}

// 处理 worker 的响应
function handleWorkerResponse(data) {
  console.log("receive message from worker:", data);
  let cb = workerResponseHandler[data.id];
  for (let i = 0, l = cb.length; i < l; i += 2) {
    if (data.error) {
      // reject error
      cb[i + 1](data.error);
    } else {
      // resolve result
      cb[i](data.result);
    }
  }
  delete workerResponseHandler[data.id];
}

// 完成工作后，从活动队列转到空闲队列
function completeWork(worker) {
  const index = activeWorkers.indexOf(worker);
  if (index >= 0) {
    activeWorkers.splice(index, 1);
  }
  idleWorkers.push(worker);
}

// 排序方法
export function sorter(a, b) {
  if (a.kind === b.kind) {
    return a.name.localeCompare(b.name);
  } else {
    return a.kind === "directory" ? -1 : 1;
  }
}

export function readableSize(size) {
  const K = 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIdx = 0;
  while (size >= 1024 && unitIdx < 4) {
    size = size / K;
    unitIdx += 1;
  }
  return `${size.toFixed(2) * 1}${units[unitIdx]}`;
}

export class OPFSQuery {
  // FileSystemDirectoryHandle

  /**
   * 根目录引用
   * @type Promise<FileSystemDirectoryHandle>
   */
  root;

  /**
   * 当前目录引用
   * @type Promise<FileSystemDirectoryHandle>
   */
  current;

  /**
   * 当前路径
   */
  workingDirectory = "";

  constructor() {
    this.root = navigator.storage.getDirectory();
    this.current = this.root;
  }

  /**
   * 改变目录
   * - option 传入 { create: true } 会在文件夹不存在时创建相应的文件夹
   */
  async cd(path = "", option) {
    // 空值时返回根目录 RootDirectory
    let current = this.root;
    let directory = "";
    const parts = path.split("/");
    for await (let part of parts) {
      if (part) {
        current = (await current).getDirectoryHandle(part, option);
        directory += `/${part}`;
      }
    }
    this.current = current;
    this.workingDirectory = directory;
    return this.current;
  }

  /**
   * 在当前目录下创建文件夹
   */
  async createDirectory(directoryName) {
    return await (
      await this.current
    ).getDirectoryHandle(directoryName, { create: true });
  }

  /**
   * 在当前目录下创建文件
   */
  async createFile(fileName) {
    return await (await this.current).getFileHandle(fileName, { create: true });
  }

  /**
   * 下载文件夹
   */
  async downloadDirectory(directoryHandle, downloadTarget) {
    if (!directoryHandle) {
      directoryHandle = await this.current;
    }
    if (!downloadTarget) {
      downloadTarget = await showDirectoryPicker({
        mode: "readwrite",
        startIn: "downloads",
      });
    }

    const directoryIterator = directoryHandle.values();
    const directoryEntryPromises = [];
    for await (const handle of directoryIterator) {
      if (handle.kind === "file") {
        const targetFile = await downloadTarget.getFileHandle(handle.name, {
          create: true,
        });
        const fileBlob = await handle.getFile();
        const writable = await targetFile.createWritable();
        await writable.write(fileBlob);
        await writable.close();
      } else if (handle.kind === "directory") {
        directoryEntryPromises.push(
          (async () => {
            const diskHandle = await downloadTarget.getDirectoryHandle(
              handle.name,
              {
                create: true,
              }
            );
            return await this.downloadDirectory(handle, diskHandle);
          })()
        );
      }
    }
    await Promise.all(directoryEntryPromises);
    return "success";
  }

  /**
   * 下载文件
   */
  async downloadFile(fileName) {
    const fileBlob = await this.getFileBlob(fileName);
    const saveHandle = await showSaveFilePicker({
      suggestedName: fileName || "",
    });
    const writable = await saveHandle.createWritable();
    await writable.write(fileBlob);
    await writable.close();
    return "success";
  }

  /**
   * 获取文件句柄 FileSystemFileHandle
   * @description
   * - 返回一个关联指定文件的 FileSystemFileHandle 对象
   * - 通常不会用到该方法，除非想自己对 FileHandle 进行操作
   */
  async getFileHandle(fileName) {
    return await (await this.current).getFileHandle(fileName);
  }

  /**
   * 获取 File 文件对象
   * @description
   * - File 对象是 Blob 的一种特定类型，可在 Blob 能够使用的任何上下文中使用。
   * - 如 FileReader、URL.createObjectURL()、createImageBitmap() 和 XMLHttpRequest.send()。
   */
  async getFileBlob(fileName) {
    return await (await this.getFileHandle(fileName)).getFile();
  }

  /**
   * 列出当前目录下的文件和文件夹
   * - option.detail: 是否获取文件的详细信息，默认为 false
   */
  async ls(option = {}) {
    const { detail } = option;
    const current = await this.current;
    // 当前目录路径
    const path = this.workingDirectory;
    const list = [];

    // 目录下的文件和文件夹异步迭代器
    const directoryIterator = current.values();
    for await (const handle of directoryIterator) {
      const relativePath = `${path}/${handle.name}`;
      if (detail && handle.kind === "file") {
        list.push(
          handle.getFile().then((file) => {
            return {
              name: handle.name,
              kind: handle.kind,
              size: file.size,
              diskcost: readableSize(file.size),
              type: file.type,
              lastModified: file.lastModified,
              relativePath,
              handle,
            };
          })
        );
      } else {
        list.push({
          name: handle.name,
          kind: handle.kind,
          relativePath,
          handle,
        });
      }
    }
    return list.sort(sorter);
  }

  /**
   * 以指定目录为根目录，获取整个目录树
   */
  async tree(directoryHandle, path = "") {
    if (!directoryHandle) {
      directoryHandle = await this.current;
    }
    const directoryIterator = directoryHandle.values();
    const entryPromises = [];
    for await (const handle of directoryIterator) {
      const relativePath = `${path}/${handle.name}`;
      if (handle.kind === "file") {
        entryPromises.push(
          handle.getFile().then((file) => {
            return {
              name: handle.name,
              kind: handle.kind,
              diskcost: readableSize(file.size),
              size: file.size,
              type: file.type,
              lastModified: file.lastModified,
              relativePath,
              handle,
            };
          })
        );
      } else if (handle.kind === "directory") {
        entryPromises.push(
          (async () => {
            return {
              name: handle.name,
              kind: handle.kind,
              relativePath,
              entries: await this.tree(handle, relativePath),
              handle,
            };
          })()
        );
      }
    }
    const directoryEntries = await Promise.all(entryPromises);
    return directoryEntries.sort(sorter);
  }

  /**
   * 删除当前目录下的指定文件或文件夹
   * - option.recursive: 设置为 true 以递归的删除子目录及文件，默认为 undefined
   */
  async remove(name, option) {
    await (await this.current).removeEntry(name, option);
    return "success";
  }

  /**
   * 删除当前目录
   * - option.recursive: 设置为 true 以递归的删除子目录及文件，默认为 undefined
   * - 删除成功后退回根目录
   */
  async removeSelf(option) {
    await (await this.current).remove(option);
    this.reset();
    return "success";
  }

  /**
   * 重命名
   */
  async rename(srcName, destName) {
    await (await this.getFileHandle(srcName)).move(destName);
    return "success";
  }

  /**
   * 重置当前目录到根目录
   * 当出现异常报错时可尝试进行重置
   */
  reset() {
    this.current = this.root;
    this.workingDirectory = "";
    return this;
  }

  /**
   * 解析文件路径
   * 返回给定文件或文件夹相对于引用目录的位置
   */
  async resolveFilePath(fileSystemhandle) {
    return await (await this.root).resolve(fileSystemhandle);
  }

  /**
   * 使用 web worker 获取文件大小
   */
  async getFileSize(fileName) {
    return new Promise(async (resolve, reject) => {
      const id = `${this.workingDirectory}/${fileName}_getSize`;
      if (workerResponseHandler[id]) {
        workerResponseHandler[id].push(resolve, reject);
      } else {
        workerResponseHandler[id] = [resolve, reject];
        const fileHandle = await this.getFileHandle(fileName);
        startWorker({
          id,
          command: "getSize",
          fileHandle,
        });
      }
    });
  }

  /**
   * 使用 web worker 读取文件数据
   * - option.at: 在指定的偏移位置开始读取。
   */
  readFile(fileName, option) {
    return new Promise(async (resolve, reject) => {
      const id = `${this.workingDirectory}/${fileName}_read`;
      if (workerResponseHandler[id]) {
        workerResponseHandler[id].push(resolve, reject);
      } else {
        workerResponseHandler[id] = [resolve, reject];
        const fileHandle = await this.getFileHandle(fileName);
        startWorker({
          id,
          command: "read",
          fileHandle,
          option,
        });
      }
    });
  }

  /**
   * 使用 web worker 调整文件大小
   * - option.flush: 是否立即将更改持久化至磁盘
   * - option.size: 要将文件调整到的字节数
   */
  async truncateFile(fileName, option) {
    const id = `${this.workingDirectory}/${fileName}_truncate`;
    if (workerResponseHandler[id]) {
      // 已存在写入操作
      return Promise.reject(new Error("Truncate fail: File is writing."));
    }
    const fileHandle = await this.getFileHandle(fileName);
    startWorker({
      id,
      command: "truncate",
      fileHandle,
      option,
    });
    return new Promise((resolve, reject) => {
      workerResponseHandler[id] = [resolve, reject];
    });
  }

  /**
   * 使用 web worker 将 buffer 写入指定文件
   * - option.at: 在指定的偏移位置写入。
   * - option.transfer: 是否转移 buffer 所有权
   * - option.flush: 是否立即将更改持久化至磁盘
   * @example
   * 获取文本 buffer: buffer = new TextEncoder().encode('Some text'); // ArrayBuffer
   */
  async writeFile(fileName, buffer, option = {}) {
    const id = `${this.workingDirectory}/${fileName}_write`;
    if (workerResponseHandler[id]) {
      // 已存在写入操作
      return Promise.reject(new Error("Write fail: File is writing."));
    }
    const { transfer, ...writeOption } = option;
    const fileHandle = await this.getFileHandle(fileName);
    startWorker(
      {
        id,
        command: "write",
        data: buffer,
        fileHandle,
        option: writeOption,
      },
      !!transfer ? [transfer] : undefined
    );
    return new Promise((resolve, reject) => {
      workerResponseHandler[id] = [resolve, reject];
    });
  }

  /**
   * 通过流式写入修改文件
   * @see https://developer.mozilla.org/zh-CN/docs/Web/API/FileSystemWritableFileStream/write
   * - 写入的数据可以是 ArrayBuffer、TypedArray、DataView、Blob 或字符串形式
   * @example
   * - writeFileStream('file.txt', 'some text'); // 覆盖式写入数据
   * - writeFileStream('file.txt', { type: 'write', position: 1024, data: 'some text' }); // 在指定位置写入数据
   * - writeFileStream('file.txt', { type: 'truncate', size: 1024 }); // 调整文件至指定字节长度
   */
  async writeFileStream(fileName, data) {
    const fileHandle = await this.getFileHandle(fileName);
    const writable = await fileHandle.createWritable();
    const result = await writable.write(data);
    await writable.close();
    return result;
  }

  /**
   * 查询用量
   */
  /* eg
  {
      "quota": 299977904946, // 限额
      "usage": 28922, // 用量
      "usageDetails": {
          "fileSystem": 28922
      }
  }
  */
  static async usage() {
    return await navigator.storage.estimate();
  }
}

export default function createOPFSQuery() {
  return new OPFSQuery();
}
