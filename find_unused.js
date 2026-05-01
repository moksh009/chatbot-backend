const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function findJsFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file === 'node_modules' || file.startsWith('.')) continue;
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      findJsFiles(filePath, fileList);
    } else if (file.endsWith('.js') || file.endsWith('.jsx')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const allFiles = findJsFiles(process.cwd());
const unused = [];

for (const file of allFiles) {
  const basename = path.basename(file, path.extname(file));
  if (basename === 'index' || basename === 'server' || basename === 'app' || basename === 'find_unused') continue;
  
  try {
    // Check if the basename is mentioned in any other file
    const result = execSync(`grep -rn --exclude-dir=node_modules --exclude-dir=.git "${basename}" . | grep -v "${file}"`, { encoding: 'utf-8' });
    if (!result.trim()) {
      unused.push(file);
    }
  } catch (e) {
    // grep returns exit code 1 if no match
    unused.push(file);
  }
}

console.log(unused.join('\n'));
