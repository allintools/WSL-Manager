from pathlib import Path
import struct
p = Path(__file__).parents[1] / 'src-tauri' / 'icons'
p.mkdir(exist_ok=True)
def distance(x, y, ax, ay, bx, by):
    t=max(0,min(1,((x-ax)*(bx-ax)+(y-ay)*(by-ay))/((bx-ax)**2+(by-ay)**2)))
    return ((x-ax-t*(bx-ax))**2+(y-ay-t*(by-ay))**2)**.5
images=[]
for size in (16,32,48,64,128,256):
    pixels=bytearray()
    for yy in range(size-1,-1,-1):
        for xx in range(size):
            x,y=xx*256/size,yy*256/size
            dx,dy=max(34-x,0,x-222),max(34-y,0,y-222)
            color=(178,216,134,255) if dx*dx+dy*dy<28**2 else (25,28,30,255)
            if min(distance(x,y,67,78,106,117),distance(x,y,106,117,67,156),distance(x,y,126,158,182,158))<8:
                color=(27,43,19,255)
            r,g,b,a=color
            pixels+=bytes((b,g,r,a))
    mask=bytes(((size+31)//32)*4*size)
    header=struct.pack('<IiiHHIIiiII',40,size,size*2,1,32,0,len(pixels)+len(mask),0,0,0,0)
    images.append((size,header+pixels+mask))
offset=6+16*len(images)
directory=bytearray(struct.pack('<HHH',0,1,len(images)))
for size,data in images:
    directory+=struct.pack('<BBBBHHII',size%256,size%256,0,0,1,32,len(data),offset)
    offset+=len(data)
(p/'icon.ico').write_bytes(directory+b''.join(data for _,data in images))
