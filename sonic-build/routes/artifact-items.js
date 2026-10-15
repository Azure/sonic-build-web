function GetArtifactItems(items){
  var results = [];
  if (items == null){
    return results;
  }
  var stack = [{items: items, index: 0}];
  while (stack.length > 0){
    var frame = stack[stack.length - 1];
    if (frame.index >= frame.items.length){
      stack.pop();
      continue;
    }

    var item = frame.items[frame.index++];
    if (item.name.startsWith("/target/versions")
     || item.name.startsWith('/target/baseimage')){
      continue;
    }

    results.push(item);
    var children = item.items;
    item['items'] = null;
    if (children != null && children.length > 0){
      stack.push({items: children, index: 0});
    }
  }

  return results;
}

module.exports = GetArtifactItems;
